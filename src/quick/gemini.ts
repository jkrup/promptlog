// Gemini Flash: the text-writing half of quick asks (per-turn map notes, the final answer).
// API: POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent, key in x-goog-api-key.
import { loadQuickConfig, USER_CONFIG_LABEL } from './config.ts';
import { postJson, type HttpOpts } from './http.ts';

export const GEMINI_MODEL = 'gemini-3.8-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiRequest {
  system?: string;
  prompt: string;
  /** JSON Schema for a JSON reply (sets responseMimeType application/json). */
  jsonSchema?: object;
  model?: string;
  maxOutputTokens?: number;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface GeminiResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type Gemini = (req: GeminiRequest) => Promise<GeminiResponse>;

export interface GeminiClientOpts extends HttpOpts {
  /** Default: $GEMINI_API_KEY, then $GOOGLE_API_KEY (repoGeminiClient adds the config files). */
  apiKey?: string;
  model?: string;
  /** Base URL in place of Google's `…/v1beta/models`, e.g. a proxy that speaks the same API. */
  url?: string;
}

interface RawGemini {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

export function geminiBody(req: GeminiRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};
  if (req.jsonSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = req.jsonSchema;
  }
  if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
  if (req.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: req.thinkingLevel };
  return {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

export function geminiClient(opts: GeminiClientOpts = {}): Gemini {
  const apiKey = opts.apiKey ?? (process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
  if (!apiKey) throw new Error(`No Gemini key found. Add "gemini": { "apiKey" } to ${USER_CONFIG_LABEL}, or set GEMINI_API_KEY (keys: https://aistudio.google.com/apikey)`);
  return async (req) => {
    const model = req.model ?? opts.model ?? GEMINI_MODEL;
    const url = `${(opts.url ?? BASE).replace(/\/+$/, '')}/${encodeURIComponent(model)}:generateContent`;
    const res = (await postJson('Gemini', url, { 'x-goog-api-key': apiKey }, geminiBody(req), opts)) as RawGemini;
    const cand = res.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text) {
      const why = res.promptFeedback?.blockReason ?? cand?.finishReason ?? 'empty reply';
      throw new Error(`Gemini returned no text (${why})`);
    }
    const u = res.usageMetadata ?? {};
    return {
      text,
      model: res.modelVersion ?? model,
      usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
    };
  };
}

/** The Gemini client for a repo: `gemini` from the config files (user, then repo) when set, else the env vars. */
export function repoGeminiClient(cwd: string, http: HttpOpts = {}): Gemini {
  const g = loadQuickConfig(cwd).gemini;
  return geminiClient({ ...http, ...(g?.apiKey ? { apiKey: g.apiKey } : {}), ...(g?.model ? { model: g.model } : {}), ...(g?.url ? { url: g.url } : {}) });
}

/** Parse a JSON reply, tolerating code fences and prose around the object. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`not JSON: ${t.slice(0, 200)}`);
  }
}
