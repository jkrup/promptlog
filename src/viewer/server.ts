// `pl view` server: node:http, bound to 127.0.0.1 only. Pages are rendered by the pure functions in
// render.ts; this file does routing, git access (via model.ts) and the optional ask/summarize modules.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gitMaybe } from '../core/git.ts';
import { assembleReview, parseRange } from '../core/review.ts';
import type { AskResult, Review, ReviewSummary } from '../core/types.ts';
import { renderDiff } from './diff.ts';
import { toHtml } from './html.ts';
import { loadAsk, loadSummarize, type AskModule, type Loaded, type SummarizeModule } from './integrations.ts';
import { mockSummary } from './mock.ts';
import { buildIndexModel, buildReviewModel, buildSessionModel, isSafeRev, isSafeSessionId, resolveSession, turnDiff, turnRaw } from './model.ts';
import {
  PAGE_SCRIPTS,
  renderAskResult,
  renderErrorPage,
  renderIndexPage,
  renderRawLog,
  renderReviewPage,
  renderSessionPage,
  renderSummaryError,
  renderSummaryFragment,
  renderSummaryUnavailable,
  reviewUrl,
} from './render.ts';
import type { Features } from './types.ts';

export interface ViewerModules {
  /** undefined: load src/ask dynamically. null: treat as not installed. */
  ask?: AskModule | null;
  summarize?: SummarizeModule | null;
}

export interface ServerOptions {
  cwd: string;
  /** 0 picks a free port. Default 4777. */
  port?: number;
  /** When the port is taken, try the next few. Default false. */
  portFallback?: boolean;
  /** Inject modules (tests); otherwise they're imported on demand. */
  modules?: ViewerModules;
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;

const CSP = [
  "default-src 'none'",
  `script-src ${PAGE_SCRIPTS.map((s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`).join(' ')}`,
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(type === 'text/html' ? { 'content-security-policy': CSP } : {}),
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, data: unknown) => send(res, status, 'application/json', JSON.stringify(data));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rev(v: string | null, name: string): string | undefined {
  if (v === null || v === '') return undefined;
  if (!isSafeRev(v)) throw new HttpError(400, `invalid ${name}: ${v}`);
  return v;
}

function positiveInt(v: unknown, name: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `invalid ${name}`);
  return n;
}

export function createViewerServer(opts: ServerOptions): { server: Server; setPort(port: number): void } {
  const cwd = opts.cwd;
  let port = 0;
  const summaries = new Map<string, Promise<ReviewSummary>>();

  const askMod = async (): Promise<Loaded<AskModule>> =>
    opts.modules?.ask === null ? { ok: false, reason: 'Asking questions at a turn (src/ask) isn\'t installed in this build yet.' } : opts.modules?.ask ? { ok: true, mod: opts.modules.ask } : loadAsk();
  const summarizeMod = async (): Promise<Loaded<SummarizeModule>> =>
    opts.modules?.summarize === null
      ? { ok: false, reason: 'The summarizer (src/summarize) isn\'t installed in this build yet.' }
      : opts.modules?.summarize
        ? { ok: true, mod: opts.modules.summarize }
        : loadSummarize();

  const features = async (): Promise<{ features: Features; ask: Loaded<AskModule> }> => {
    const [ask, sum] = await Promise.all([askMod(), summarizeMod()]);
    return {
      ask,
      features: {
        ask: ask.ok ? { available: true } : { available: false, reason: ask.reason },
        summary: sum.ok ? { available: true } : { available: false, reason: sum.reason },
      },
    };
  };

  const pastAsks = async (ask: Loaded<AskModule>, sessionIds: string[]): Promise<Map<string, AskResult[]>> => {
    const out = new Map<string, AskResult[]>();
    if (!ask.ok || !ask.mod.listAsks) return out;
    for (const sid of sessionIds) {
      try {
        out.set(sid, await ask.mod.listAsks(cwd, sid));
      } catch {
        // A broken asks thread shouldn't take the page down.
      }
    }
    return out;
  };

  const reviewRange = (url: URL): { base: string; head: string } => {
    const base = rev(url.searchParams.get('base'), 'base');
    const head = rev(url.searchParams.get('head'), 'head');
    const r = parseRange(cwd, head);
    return { base: base ?? r.base, head: head ?? r.head };
  };

  const loadReview = (base: string, head: string): Review => {
    for (const [name, v] of [
      ['base', base],
      ['head', head],
    ] as const)
      if (!gitMaybe(['rev-parse', '--verify', '-q', `${v}^{commit}`], { cwd })) throw new HttpError(404, `unknown ${name} revision: ${v}`);
    return assembleReview(cwd, base, head);
  };

  const sessionParam = (v: unknown): string => {
    if (typeof v !== 'string' || !isSafeSessionId(v)) throw new HttpError(400, 'invalid session id');
    const id = resolveSession(cwd, v);
    if (!id) throw new HttpError(404, `no session ${v}`);
    return id;
  };

  const allowedHost = (req: IncomingMessage) => {
    const h = req.headers.host ?? '';
    return [`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h);
  };
  const allowedOrigin = (req: IncomingMessage) => {
    const o = req.headers.origin;
    return !o || [`http://${HOST}:${port}`, `http://localhost:${port}`].includes(o);
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/') {
      return send(res, 200, 'text/html', renderIndexPage(buildIndexModel(cwd)));
    }

    if (method === 'GET' && path === '/review') {
      const { base, head } = reviewRange(url);
      const review = loadReview(base, head);
      const f = await features();
      const model = buildReviewModel(cwd, base, head, { features: f.features, review, asks: await pastAsks(f.ask, review.slices.map((s) => s.sessionId)) });
      if (url.searchParams.get('mockSummary') === '1') model.summary = { data: mockSummary(review), mock: true };
      return send(res, 200, 'text/html', renderReviewPage(model));
    }

    const sm = /^\/session\/([^/]+)\/?$/.exec(path);
    if (method === 'GET' && sm) {
      const id = sessionParam(decodeURIComponent(sm[1]!));
      const f = await features();
      const model = buildSessionModel(cwd, id, { features: f.features, asks: await pastAsks(f.ask, [id]) });
      if (!model) throw new HttpError(404, `no session ${id}`);
      return send(res, 200, 'text/html', renderSessionPage(model));
    }

    if (method === 'GET' && path === '/api/turn-diff') {
      const id = sessionParam(url.searchParams.get('session'));
      const turn = positiveInt(url.searchParams.get('turn'), 'turn');
      const span = url.searchParams.get('span') === 'human' ? 'human' : 'agent';
      const d = turnDiff(cwd, id, turn, span);
      if (!d) throw new HttpError(404, `no turn ${turn} in session ${id}`);
      if (url.searchParams.get('format') === 'html') {
        const empty = span === 'human' ? 'No edits between these turns.' : 'No file changes in this turn.';
        return send(res, 200, 'text/html', toHtml(renderDiff(d.text, { emptyText: empty, truncated: d.truncated })));
      }
      return send(res, 200, 'text/plain', d.text);
    }

    if (method === 'GET' && path === '/api/turn-raw') {
      const id = sessionParam(url.searchParams.get('session'));
      const turn = positiveInt(url.searchParams.get('turn'), 'turn');
      const lines = turnRaw(cwd, id, turn);
      if (!lines) throw new HttpError(404, `no turn ${turn} in session ${id}`);
      if (url.searchParams.get('format') === 'html') return send(res, 200, 'text/html', toHtml(renderRawLog(lines, `/api/turn-raw?session=${encodeURIComponent(id)}&turn=${turn}`)));
      return send(res, 200, 'text/plain', lines.join('\n') + '\n');
    }

    if (method === 'GET' && path === '/api/summary') {
      const { base, head } = reviewRange(url);
      const review = loadReview(base, head);
      const f = await features();
      if (url.searchParams.get('mock') === '1') return sendJson(res, 200, { ok: true, mock: true, summary: mockSummary(review), ...renderSummaryFragment({ review, features: f.features }, mockSummary(review)) });
      const mod = await summarizeMod();
      if (!mod.ok) {
        const html = toHtml(renderSummaryUnavailable(mod.reason, { api: '', mock: reviewUrl(base, head, { mockSummary: '1' }) }));
        return sendJson(res, 501, { ok: false, unavailable: true, error: mod.reason, html });
      }
      const refresh = url.searchParams.get('refresh') === '1';
      const headSha = gitMaybe(['rev-parse', head], { cwd }) ?? head;
      const key = `${review.mergeBase}..${headSha}`;
      let p = refresh ? undefined : summaries.get(key);
      if (!p) {
        p = mod.mod.summarizeReview(cwd, review, { refresh });
        summaries.set(key, p);
        p.catch(() => summaries.delete(key));
      }
      try {
        const summary = await p;
        return sendJson(res, 200, { ok: true, summary, ...renderSummaryFragment({ review, features: f.features }, summary) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return sendJson(res, 500, { ok: false, error: msg, html: toHtml(renderSummaryError(msg)) });
      }
    }

    if (path === '/api/ask') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      if (!allowedOrigin(req)) throw new HttpError(403, 'cross-origin request refused');
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'expected application/json');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, 'invalid JSON body');
      }
      const sessionId = sessionParam(body.sessionId);
      const turn = positiveInt(body.turn, 'turn');
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || question.length > 8000) throw new HttpError(400, 'question must be 1-8000 characters');
      const model = typeof body.model === 'string' && /^[\w.:\-[\]]{1,80}$/.test(body.model) ? body.model : undefined;
      if (!turnRaw(cwd, sessionId, turn)) throw new HttpError(404, `no turn ${turn} in session ${sessionId}`);
      const mod = await askMod();
      if (!mod.ok) return sendJson(res, 501, { ok: false, unavailable: true, error: mod.reason });
      try {
        const result = await mod.mod.ask({ cwd, sessionId, turn, question, ...(model ? { model } : {}) });
        return sendJson(res, 200, { ok: true, result, html: toHtml(renderAskResult(result)) });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (path === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(404, `nothing at ${path}`);
  }

  const server = createServer((req, res) => {
    if (!allowedHost(req)) return send(res, 403, 'text/plain', 'forbidden host\n');
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const msg = e instanceof Error ? e.message : String(e);
      if (res.headersSent) return res.end();
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path.startsWith('/api/')) return sendJson(res, status, { ok: false, error: msg });
      return send(res, status, 'text/html', renderErrorPage(status, status === 404 ? 'Not found' : status === 400 ? 'Bad request' : 'Something went wrong', msg));
    });
  });
  // Asks and summaries run a model and can take minutes.
  server.requestTimeout = 15 * 60 * 1000;
  return { server, setPort: (p) => (port = p) };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { server, setPort } = createViewerServer(opts);
  const want = opts.port ?? 4777;
  let port = -1;
  for (let attempt = 0; attempt < (opts.portFallback && want !== 0 ? 10 : 1); attempt++) {
    try {
      port = await listen(server, want === 0 ? 0 : want + attempt);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !opts.portFallback || attempt === 9) throw e;
    }
  }
  setPort(port);
  return {
    server,
    port,
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
