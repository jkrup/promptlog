// Secret redaction for transcript text, applied before anything is written to the store.
//
// Transcripts are JSONL. Each line is parsed, every string value is redacted (structural fields such as ids and
// thinking signatures are left alone so `claude --resume` keeps working), and the line is re-serialized only if
// something changed. Lines that don't parse fall back to regex redaction on the raw text.
//
// Design borrows from Entire's `redact/` package (MIT): provider token prefixes, credentialed URIs, key/value
// credentials with placeholder detection, and entropy checks. Unlike Entire, entropy is only used in `KEY=value`
// (dotenv-style) contexts, to keep false positives in code and prose low.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from '../core/store.ts';

export type { Redactor };

export interface RedactRule {
  /** Shows up in the replacement: `[REDACTED:<kind>]`. */
  kind: string;
  /** Must be global. With `group`, it also needs the `d` flag (match indices). */
  re: RegExp;
  /** Redact only this capture group (number or name); default the whole match. */
  group?: number | string;
  /** Return false to keep a candidate (e.g. placeholders, code). Gets the text that would be redacted. */
  accept?: (value: string, m: RegExpExecArray) => boolean;
  /** Per-match kind, e.g. derived from the key name. Defaults to `kind`. */
  kindOf?: (m: RegExpExecArray) => string;
}

export interface RedactConfig {
  /** Extra patterns: `[{ "name": "corp-token", "regex": "corp_[a-z0-9]{32}", "flags": "i" }]` or `{ "corp-token": "..." }`. A named group `(?<secret>...)` limits redaction to that group. */
  patterns?: { name: string; regex: string; flags?: string }[] | Record<string, string>;
  /** Built-in kinds to turn off, e.g. `["high-entropy"]`. */
  disable?: string[];
  /** Regexes; a candidate that fully matches one of them is kept. */
  allow?: string[];
}

export const REDACT_CONFIG_PATH = '.promptlog/redact.json';
export const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_WORDS = new Set([
  'redacted', 'changeme', 'change_me', 'example', 'placeholder', 'secret', 'password', 'token', 'xxx', 'null', 'none', 'nil',
  'undefined', 'true', 'false', 'string', 'str', 'number', 'int', 'bool', 'boolean', 'any', 'unknown', 'required', 'optional',
  'your_password', 'your_token', 'your_secret', 'your_api_key', 'your-api-key', 'your-token', 'mypassword', 'password123', 'test',
  'dummy', 'fake', 'todo', 'tbd', 'env', 'default', 'hidden', 'masked', 'empty', 'value', 'redact', '...',
]);

/** Documentation placeholders, masks, prior redactions and variable references: not secrets. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["'`]|["'`]$/g, '');
  if (v.length < 3) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  if (/^\[redacted(?::[\w.-]+)?\]$/i.test(v)) return true;
  if (/^<[^<>]*>$/.test(v) || /^\{\{.*\}\}$/.test(v)) return true; // <your-token>, {{ secrets.X }}
  if (/^\$\{?[A-Za-z_][\w.:-]*\}?$/.test(v) || /^\$\(.*\)$/.test(v) || /^%[A-Za-z_]\w*%$/.test(v)) return true; // $VAR, ${VAR}, $(cmd), %VAR%
  if (/^(?:process\.env|os\.environ|os\.getenv|env::var|System\.getenv|ENV\[)/.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true; // ****, xxxx, ....
  if (/^(?:your|my|some|insert|enter|replace)[_-]/i.test(v)) return true;
  if (/^\d+$/.test(v)) return true; // counts, ports, limits
  return false;
}

const hasLetterAndDigit = (s: string) => /[A-Za-z]/.test(s) && /\d/.test(s);

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

// Words that make a key name secret-bearing when they end it: DB_PASSWORD, github_token, stripeApiKey, client-secret...
const SECRET_KEY_WORDS = String.raw`(?:pass(?:word|wd|phrase)|secret(?:[_-]?key)?|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|credentials?)`;
// A key must not be preceded by an identifier char. In the raw-text fallback a JSON escape like `\n` can precede the key,
// so a leading escape letter is also accepted as a boundary.
const KEY_START = String.raw`(?:(?<=\\[nrt])|(?<![A-Za-z0-9_]))`;

function kindForKey(key: string): string {
  const k = key.toLowerCase();
  if (/pass/.test(k)) return 'password';
  if (/token$/.test(k)) return 'token';
  if (/key$/.test(k)) return 'api-key';
  if (/credentials?$/.test(k)) return 'credential';
  return 'secret';
}

const COMMON_WORDS = /^(?:string|str|number|int|bool|boolean|any|unknown|object|none|null|undefined|optional|required)\b/i;

// Optional line-number prefix from tool output (Claude Code's Read tool prints `     12→content` or `12\tcontent`).
const LINE_PREFIX = String.raw`(?:[ \t]*\d+(?:→|\t))?`;

function assignmentRules(): RedactRule[] {
  const key = String.raw`([A-Za-z0-9_.-]*?${SECRET_KEY_WORDS})`;
  const kindOf = (m: RegExpExecArray) => kindForKey(m[1] ?? '');
  return [
    // key = "value" / key: 'value' / "key": "value" (quoted values: code, JSON, YAML)
    {
      kind: 'secret',
      kindOf,
      re: new RegExp(String.raw`${KEY_START}${key}\\?["']?\s*(?:=|:|:=|=>)\s*(\\?["'])(?<value>(?:(?!\2)[^\n])*?)\2`, 'gid'),
      group: 'value',
      accept: (v) => !isPlaceholder(v) && !/^\s|\s$/.test(v) && !/\s{2,}/.test(v),
    },
    // key=value, no spaces around '=' (dotenv, shell, URL query strings, --flags). Not `==`/`=>` (code).
    {
      kind: 'secret',
      kindOf,
      re: new RegExp(String.raw`${KEY_START}${key}=(?![=>])(?<value>[^\s"'\`,;&<>()\[\]{}\\]+)`, 'gid'),
      group: 'value',
      accept: (v) => !isPlaceholder(v),
    },
    // YAML-ish `key: value` alone on its line
    {
      kind: 'secret',
      kindOf,
      re: new RegExp(String.raw`^${LINE_PREFIX}[ \t-]*${key}:[ \t]+(?<value>[^\s"'#][^\s#]*)[ \t]*$`, 'gimd'),
      group: 'value',
      accept: (v) => !isPlaceholder(v) && !COMMON_WORDS.test(v) && !/[()[\]{};]/.test(v),
    },
  ];
}

export function builtinRules(): RedactRule[] {
  return [
    {
      kind: 'private-key',
      // Whole block when the END line is present; otherwise the BEGIN line plus following base64/header lines (truncated output).
      re: new RegExp(
        String.raw`-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----|(?:(?:\r?\n|\\[rn])+${LINE_PREFIX}(?:[A-Za-z0-9+/=]{8,}|[A-Za-z-]+: [^\n\\]*))*)`,
        'g',
      ),
    },
    { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g },
    {
      kind: 'aws-secret-key',
      re: /(?:aws_?secret_?access_?key|aws_?secret_?key)\\?["']?\s*[:=]\s*\\?["']?(?<value>[A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gid,
      group: 'value',
    },
    { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
    { kind: 'gitlab-token', re: /\bgl(?:pat|dt|rt|ptt|cbt|oas|soat|ffct|imt|agent)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g },
    { kind: 'slack-token', re: /\bxox[abposre]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/g },
    { kind: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{8,}/g },
    { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{20,}/g },
    { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
    { kind: 'openai-key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, accept: hasLetterAndDigit },
    { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
    { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
    {
      kind: 'bearer-token',
      re: /\b[Bb]earer\s+(?<value>[A-Za-z0-9._~+/-]{16,}=*)/gd,
      group: 'value',
      accept: (v) => !isPlaceholder(v) && hasLetterAndDigit(v),
    },
    {
      kind: 'url-password',
      re: /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@"'`<>:\\]*:(?<value>[^\s/?#@"'`<>\\]+)@/gid,
      group: 'value',
      accept: (v) => !isPlaceholder(v),
    },
    ...assignmentRules(),
    // KEY=value in dotenv/shell style: redact values that look generated (long, mixed letters+digits, high entropy).
    {
      kind: 'high-entropy',
      re: new RegExp(String.raw`${KEY_START}(?:export\s+)?[A-Z][A-Z0-9_]*=(\\?["']?)(?<value>[^\s"'\`\\]{16,})\1`, 'gd'),
      group: 'value',
      accept: (v) => hasLetterAndDigit(v) && shannonEntropy(v) >= 3.5 && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[~.]?\/)/i.test(v) && !isPlaceholder(v),
    },
  ];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Region {
  start: number;
  end: number;
  kind: string;
}

function findRegions(text: string, rules: RedactRule[], allow: RegExp[]): Region[] {
  const regions: Region[] = [];
  for (const rule of rules) {
    const re = rule.re;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      let start = m.index;
      let end = m.index + m[0].length;
      let value = m[0];
      if (rule.group !== undefined) {
        const g = typeof rule.group === 'number' ? m.indices?.[rule.group] : m.indices?.groups?.[rule.group];
        if (!g) continue;
        [start, end] = g;
        value = text.slice(start, end);
        if (!value) continue;
      }
      if (rule.accept && !rule.accept(value, m)) continue;
      if (allow.some((a) => a.test(value))) continue;
      regions.push({ start, end, kind: rule.kindOf?.(m) ?? rule.kind });
    }
  }
  return regions;
}

function applyRegions(text: string, regions: Region[]): string {
  if (regions.length === 0) return text;
  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Region[] = [{ ...regions[0]! }];
  for (const r of regions.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (r.start < last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = '';
  let pos = 0;
  for (const r of merged) {
    out += text.slice(pos, r.start) + PLACEHOLDER(r.kind);
    pos = r.end;
  }
  return out + text.slice(pos);
}

/** JSON keys whose values are structural and must never change (ids, signatures). */
function skipKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.endsWith('id') || k.endsWith('ids') || k.endsWith('signature');
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function walk(v: Json, fn: (s: string) => string): { value: Json; changed: boolean } {
  if (typeof v === 'string') {
    const r = fn(v);
    return { value: r, changed: r !== v };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = walk(x, fn);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: out, changed } : { value: v, changed: false };
  }
  if (v && typeof v === 'object') {
    // Base64 payloads (images, documents) are data, not text.
    if (v.type === 'base64' || (typeof v.type === 'string' && v.type.startsWith('image'))) return { value: v, changed: false };
    let out: { [k: string]: Json } | null = null;
    for (const [k, x] of Object.entries(v)) {
      if (skipKey(k)) continue;
      const r = walk(x, fn);
      if (r.changed) {
        out ??= { ...v };
        out[k] = r.value;
      }
    }
    return out ? { value: out, changed: true } : { value: v, changed: false };
  }
  return { value: v, changed: false };
}

export interface RedactorOptions {
  config?: RedactConfig;
  /** Called with a message for each invalid config entry. */
  onWarning?: (msg: string) => void;
}

function compileConfig(config: RedactConfig | undefined, warn: (m: string) => void): { rules: RedactRule[]; allow: RegExp[] } {
  const disabled = new Set(config?.disable ?? []);
  const rules = builtinRules().filter((r) => !disabled.has(r.kind));
  const allow: RegExp[] = [];
  const raw = config?.patterns;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).map(([name, regex]) => ({ name, regex })) : [];
  for (const p of list) {
    if (!p || typeof p.regex !== 'string' || !p.regex) {
      warn(`redact.json: pattern ${JSON.stringify(p?.name)} has no regex`);
      continue;
    }
    const flags = [...new Set(((p as { flags?: string }).flags ?? '').replace(/[^imsu]/g, '') + 'gd')].join('');
    try {
      const re = new RegExp(p.regex, flags);
      const name = typeof p.name === 'string' && /^[\w.-]+$/.test(p.name) ? p.name : 'custom';
      rules.push({ kind: name, re, ...(p.regex.includes('(?<secret>') ? { group: 'secret' } : {}) });
    } catch {
      warn(`redact.json: pattern ${JSON.stringify(p.name)} is not a valid regular expression`); // never echo the pattern itself
    }
  }
  for (const a of config?.allow ?? []) {
    try {
      allow.push(new RegExp(`^(?:${a})$`));
    } catch {
      warn('redact.json: an allow entry is not a valid regular expression');
    }
  }
  return { rules, allow };
}

/** Redact plain text (no JSON awareness). */
export function redactText(text: string, opts: RedactorOptions = {}): string {
  const { rules, allow } = compileConfig(opts.config, opts.onWarning ?? (() => {}));
  return applyRegions(text, findRegions(text, rules, allow));
}

/**
 * Build a Redactor for `CaptureInput.redact`. Input may be one JSONL line, a whole JSONL file, or plain text.
 * Each line that parses as a JSON object/array has its string values redacted and is re-serialized only if changed;
 * other lines are redacted as raw text. Output keeps the same number of lines.
 */
export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const { rules, allow } = compileConfig(opts.config, opts.onWarning ?? (() => {}));
  const redactString = (s: string) => (s.length < 8 ? s : applyRegions(s, findRegions(s, rules, allow)));
  const redactLine = (line: string): string => {
    const t = line.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      let parsed: Json | undefined;
      try {
        parsed = JSON.parse(line) as Json;
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const r = walk(parsed, redactString);
        return r.changed ? JSON.stringify(r.value) : line;
      }
    }
    return redactString(line);
  };
  return (text: string) => (text.includes('\n') ? text.split('\n').map(redactLine).join('\n') : redactLine(text));
}

/** Read `.promptlog/redact.json` from the repo root. Missing file = no config. */
export function loadRedactConfig(root: string, onWarning?: (msg: string) => void): RedactConfig | undefined {
  const p = join(root, REDACT_CONFIG_PATH);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
    return v as RedactConfig;
  } catch (err) {
    onWarning?.(`${REDACT_CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}; using built-in rules only`);
    return undefined;
  }
}

/** The redactor used by capture: built-in rules plus the repo's `.promptlog/redact.json`. */
export function repoRedactor(root: string, onWarning?: (msg: string) => void): Redactor {
  return createRedactor({ config: loadRedactConfig(root, onWarning), onWarning });
}
