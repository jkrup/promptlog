// JSON over HTTPS for the quick-ask model APIs (Jev, Gemini). Global fetch, so no dependencies.
// Retries rate limits, overloads and network errors with backoff (honouring retry-after).

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(what: string, status: number, body: string) {
    super(`${what} failed: HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface HttpOpts {
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  timeoutMs?: number;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  const s = v ? Number(v) : NaN;
  return Number.isFinite(s) && s >= 0 ? Math.min(30_000, s * 1000) : undefined;
}

/** POST `body` as JSON and parse the JSON reply. `what` names the call in errors (never include secrets). */
export async function postJson(what: string, url: string, headers: Record<string, string>, body: unknown, opts: HttpOpts = {}): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new Error(`${what} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(what, res.status, `not JSON: ${text}`);
      }
    }
    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      await sleep(retryAfterMs(res) ?? backoff(attempt));
      continue;
    }
    throw new HttpError(what, res.status, text);
  }
}

/** First non-empty env var among `names`, or a clear error saying which one to set. */
export function envKey(names: string[], what: string, where: string): string {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  throw new Error(`${what} needs an API key: set ${names[0]} (get one at ${where})`);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
