// Jev (TypeSafe AI): a "System One" model. Send a state plus typed questions, get typed answers with probabilities.
// It doesn't write text. We use it for fast, cheap yes/no judgments; code makes the decisions.
// API: https://docs.typesafe.ai/api (POST /v1/systemone). Limits: 32k tokens for state + the longest question.
// Any endpoint with the same shape works (e.g. the Dopp proxy, https://dopp.sh/docs.md): see config.ts.
import { loadQuickConfig, LOCAL_CONFIG_PATH, USER_CONFIG_LABEL } from './config.ts';
import { postJson, type HttpOpts } from './http.ts';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
/** Input tokens only; output is free. */
export const JEV_USD_PER_MTOK = 0.042;

export type Structured = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'noul'; instructions: Structured; criteria?: { true?: Structured; false?: Structured } }
  | { type: 'choice'; instructions: Structured; criteria: Record<string, Structured | null> }
  | { type: 'score'; instructions: Structured; criteria: Structured[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface JevRequest {
  state: Structured;
  questions: Record<string, JevQuestion>;
  model?: string;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export type Jev = (req: JevRequest) => Promise<JevResponse>;

export interface JevClientOpts extends HttpOpts {
  /** Default: TypeSafe's endpoint. */
  url?: string;
  /** Default: $TYPESAFE_API_KEY. */
  apiKey?: string;
  model?: string;
}

export function jevClient(opts: JevClientOpts = {}): Jev {
  const url = opts.url ?? JEV_URL;
  const apiKey = opts.apiKey ?? (url === JEV_URL ? process.env.TYPESAFE_API_KEY?.trim() : undefined);
  if (!apiKey) {
    throw new Error(
      url === JEV_URL
        ? `No decision endpoint key found. Add "decision": { "url", "apiKey" } to ${USER_CONFIG_LABEL}, or set TYPESAFE_API_KEY (see docs/quick-ask.md)`
        : `${url} needs a key: add decision.apiKey to ${USER_CONFIG_LABEL} (or ${LOCAL_CONFIG_PATH} in this repo)`,
    );
  }
  const what = url === JEV_URL ? 'Jev' : `Decision API (${new URL(url).host})`;
  return async (req) => {
    const body = { state: req.state, model: req.model ?? opts.model ?? JEV_MODEL, questions: req.questions };
    const res = (await postJson(what, url, { authorization: `Bearer ${apiKey}` }, body, opts)) as Partial<JevResponse>;
    if (!res || typeof res.answers !== 'object' || !res.answers) throw new Error(`${what} returned no answers`);
    return {
      model: typeof res.model === 'string' ? res.model : body.model,
      answers: res.answers,
      usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
    };
  };
}

/** The decision client for a repo: `decision` from the config files (user, then repo) when set (e.g. Dopp), else TypeSafe. */
export function decisionClient(cwd: string, http: HttpOpts = {}): Jev {
  const d = loadQuickConfig(cwd).decision;
  return jevClient({ ...http, ...(d?.url ? { url: d.url } : {}), ...(d?.apiKey ? { apiKey: d.apiKey } : {}), ...(d?.model ? { model: d.model } : {}) });
}

/** The yes-probability of a noul answer; 0 when missing or malformed (treated as "no evidence"). */
export function noul(res: JevResponse, id: string): number {
  const a = res.answers[id];
  return a && a.type === 'noul' && typeof a.noul === 'number' && Number.isFinite(a.noul) ? Math.min(1, Math.max(0, a.noul)) : 0;
}
