// Tiny HTML builder with escaping by default. Pure: no Node APIs (the viewer must be able to run on Workers).
//
//   html`<p title="${userText}">${userText}</p>`   -> both interpolations are escaped
//   html`<div>${raw(trustedMarkup)}</div>`          -> opt out explicitly
//   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`  -> arrays and nested Safe values compose

export interface Safe {
  readonly __html: string;
}

export type Html = Safe | string | number | boolean | null | undefined | Html[];

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for both element content and quoted attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

export function raw(s: string): Safe {
  return { __html: s };
}

export function isSafe(v: unknown): v is Safe {
  return typeof v === 'object' && v !== null && typeof (v as Safe).__html === 'string';
}

/** Render any Html value to a string. Plain strings are escaped; null/undefined/false render as nothing. */
export function toHtml(v: Html): string {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (isSafe(v)) return v.__html;
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Html[]): Safe {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]!) + strings[i + 1]!;
  return raw(out);
}

/** Join Html fragments with a separator (escaped unless Safe). */
export function join(parts: Html[], sep: Html): Safe {
  const s = toHtml(sep);
  return raw(parts.map(toHtml).filter(Boolean).join(s));
}

/** Only allow URLs that can't execute script: http(s), mailto, in-page anchors and root-relative paths. */
export function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^#/.test(u)) return u;
  if (/^\/(?!\/)/.test(u)) return u;
  return null;
}

/** Build a query string from defined values. */
export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
