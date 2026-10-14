// AI for the container, through the Worker's own AI binding, so the container holds no provider keys.
//
//   POST /__ai/systemone                 Jev-shaped request  -> Clef (Workers AI)
//   POST /__ai/gemini/<model>:generateContent   Gemini-shaped request -> Gemini via AI Gateway (Unified Billing)
//
// promptlog's quick-ask clients already speak these two shapes; the container's config points them here.
// Callers authenticate with a key derived from VIEW_KEY (Bearer for systemone, x-goog-api-key for gemini).

export interface AiEnv {
  AI: { run(model: string, input: unknown, opts?: unknown): Promise<unknown> };
  AI_GATEWAY: string;
}

const CLEF_MODELS: Record<string, string> = {
  'clef-flash': '@cf/cloudflare/clef-flash',
  '@cf/cloudflare/clef-flash': '@cf/cloudflare/clef-flash',
  clef: '@cf/cloudflare/clef',
  '@cf/cloudflare/clef': '@cf/cloudflare/clef',
};
const DEFAULT_CLEF = '@cf/cloudflare/clef-flash';

/** A key for one purpose, HMAC(VIEW_KEY, purpose), so there's no second secret to manage. */
export async function derivedKey(viewKey: string, purpose: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(viewKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(purpose)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The key the container uses for /__ai/*. */
export const aiKey = (viewKey: string) => derivedKey(viewKey, 'ai-proxy');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleAi(req: Request, env: AiEnv, key: string): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== 'POST') return json(405, { error: 'use POST' });
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const given = bearer ?? req.headers.get('x-goog-api-key') ?? '';
  if (given !== key) return json(401, { error: 'bad key' });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid JSON' });
  }

  try {
    if (url.pathname === '/__ai/systemone') return json(200, await clef(env, body));
    const m = /^\/__ai\/gemini\/(.+):generateContent$/.exec(url.pathname);
    if (m) return json(200, await gemini(env, decodeURIComponent(m[1]!), body));
    return json(404, { error: 'unknown AI route' });
  } catch (e) {
    return json(502, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Jev's /v1/systemone shape in and out; Clef is API-compatible, so mostly a pass-through. */
export async function clef(env: AiEnv, body: Record<string, unknown>): Promise<unknown> {
  const model = CLEF_MODELS[String(body.model ?? '')] ?? DEFAULT_CLEF;
  const raw = (await env.AI.run(model, { state: body.state, questions: body.questions })) as Record<string, unknown>;
  const res = (raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw) as Record<string, unknown>;
  if (!res || typeof res.answers !== 'object') throw new Error(`Clef returned no answers: ${JSON.stringify(raw).slice(0, 300)}`);
  return { model: typeof res.model === 'string' ? res.model : model, answers: res.answers, usage: res.usage ?? { input_tokens: 0, output_tokens: 0 } };
}

interface GeminiBody {
  contents?: { role?: string; parts?: { text?: string }[] }[];
  systemInstruction?: { parts?: { text?: string }[] };
  generationConfig?: { responseMimeType?: string; responseJsonSchema?: object; maxOutputTokens?: number };
}

const partsText = (parts?: { text?: string }[]) => (parts ?? []).map((p) => p.text ?? '').join('');

/** Gemini's generateContent shape in and out, sent as chat messages through AI Gateway's Unified Billing. */
async function gemini(env: AiEnv, model: string, body: Record<string, unknown>): Promise<unknown> {
  const b = body as GeminiBody;
  const messages = [
    ...(b.systemInstruction ? [{ role: 'system', content: partsText(b.systemInstruction.parts) }] : []),
    ...(b.contents ?? []).map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: partsText(c.parts) })),
  ];
  const g = b.generationConfig ?? {};
  const input: Record<string, unknown> = { messages };
  if (g.maxOutputTokens) input.max_tokens = g.maxOutputTokens;
  if (g.responseJsonSchema) input.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: g.responseJsonSchema } };
  else if (g.responseMimeType === 'application/json') input.response_format = { type: 'json_object' };

  // Models Cloudflare hosts (@cf/…) run on Workers AI and bill to the Workers plan. Anything else (e.g. Gemini)
  // goes through AI Gateway's Unified Billing, which needs credits.
  const workersAi = model.startsWith('@cf/');
  if (workersAi) {
    input.max_tokens ??= 4096;
    // Reasoning models (Qwen 3.x) think at length before answering; promptlog's calls want the answer only.
    input.chat_template_kwargs = { enable_thinking: false };
    if (g.responseJsonSchema) {
      // JSON mode isn't on every Workers AI model: also state the schema, and parse JSON out of plain text below.
      const rule = `Reply with JSON only, matching this JSON Schema:\n${JSON.stringify(g.responseJsonSchema)}`;
      if (messages[0]?.role === 'system') messages[0].content += `\n\n${rule}`;
      else messages.unshift({ role: 'system', content: rule });
    }
  }
  let raw: Record<string, any>;
  try {
    raw = (await env.AI.run(workersAi ? model : model.includes('/') ? model : `google/${model}`, input, workersAi ? undefined : { gateway: { id: env.AI_GATEWAY } })) as Record<string, any>;
  } catch (e) {
    if (!workersAi || (!input.response_format && !input.chat_template_kwargs)) throw e;
    delete input.response_format;
    delete input.chat_template_kwargs;
    raw = (await env.AI.run(model, input)) as Record<string, any>;
  }
  const reply = raw?.choices?.[0]?.message?.content ?? raw?.response ?? raw?.result?.response ?? partsText(raw?.candidates?.[0]?.content?.parts);
  const text = cleanText(typeof reply === 'string' ? reply : reply == null ? '' : JSON.stringify(reply), !!g.responseJsonSchema);
  if (!text) throw new Error(`${model} returned no text: ${JSON.stringify(raw).slice(0, 300)}`);
  const usage = raw?.usage ?? {};
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: usage.prompt_tokens ?? 0, candidatesTokenCount: usage.completion_tokens ?? 0 },
    modelVersion: model,
  };
}

/** Drop reasoning blocks; for JSON replies, keep the outermost {…} so code fences and preambles don't break parsing. */
function cleanText(text: string, wantJson: boolean): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (wantJson) {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
  }
  return t;
}
