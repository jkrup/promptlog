// Quick-ask settings (keys), read from two places. Later wins, field by field:
//   1. ~/.config/promptlog/config.json        yours, for every repo ($XDG_CONFIG_HOME respected)
//   2. <repo>/.promptlog/config.local.json    per-repo override (gitignored)
// Shape:
//   { "decision": { "url": "https://dopp.sh/v1/systemone", "apiKey": "us_…", "model": "jev-latest" },
//     "gemini": { "apiKey": "…", "model": "gemini-3.8-flash", "url": "<optional proxy base URL>" } }
// `decision` points the Jev-style calls at any /v1/systemone endpoint with the same request and response shape,
// e.g. the Dopp proxy. Without it, calls go to TypeSafe with $TYPESAFE_API_KEY. `gemini` falls back to
// $GEMINI_API_KEY / $GOOGLE_API_KEY.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../core/git.ts';

export const LOCAL_CONFIG_PATH = '.promptlog/config.local.json';
/** How the user-level file is named in messages. */
export const USER_CONFIG_LABEL = '~/.config/promptlog/config.json';

export function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'promptlog', 'config.json');
}

export interface QuickConfig {
  decision?: { url?: string; apiKey?: string; model?: string };
  gemini?: { apiKey?: string; model?: string; url?: string };
}

function readConfig(path: string, label: string): QuickConfig {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${label}: not valid JSON (${(err as Error).message})`);
  }
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out: QuickConfig = {};
  const d = obj(obj(raw)?.decision);
  if (d) {
    out.decision = { url: str(d.url), apiKey: str(d.apiKey), model: str(d.model) };
    if (out.decision.url && !/^https:\/\//.test(out.decision.url)) throw new Error(`${label}: decision.url must start with https://`);
  }
  const g = obj(obj(raw)?.gemini);
  if (g) {
    out.gemini = { apiKey: str(g.apiKey), model: str(g.model), url: str(g.url) };
    if (out.gemini.url && !/^https:\/\//.test(out.gemini.url)) throw new Error(`${label}: gemini.url must start with https://`);
  }
  return out;
}

/** `b`'s defined fields over `a`'s. */
function over<T extends object>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, unknown> = {};
  for (const src of [a, b]) for (const [k, v] of Object.entries(src ?? {})) if (v !== undefined) out[k] = v;
  return out as T;
}

export function loadQuickConfig(cwd: string): QuickConfig {
  const user = readConfig(userConfigPath(), USER_CONFIG_LABEL);
  const root = repoRoot(cwd);
  const repo = root ? readConfig(join(root, LOCAL_CONFIG_PATH), LOCAL_CONFIG_PATH) : {};
  const decision = over(user.decision, repo.decision);
  const gemini = over(user.gemini, repo.gemini);
  return { ...(decision ? { decision } : {}), ...(gemini ? { gemini } : {}) };
}
