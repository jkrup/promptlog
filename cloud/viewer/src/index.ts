// promptlog's review page on Cloudflare: a Worker in front of a Container that runs the stock `promptlog view`
// against a clone of an Artifacts repo. Open it on any device with the secret link.
//
//   phone --> Worker (checks the key, mints a read token) --> Container (git fetch from Artifacts + promptlog view)
//
// Also here: the lease table shared by agents on different machines (/__leases/*, /leases; see leases.ts), and public
// repos (PUBLIC_REPOS, e.g. a demo) that anyone can read without the key: GET pages only, and no AI.
import { Container } from '@cloudflare/containers';
import { aiKey, handleAi, type AiEnv } from './ai.ts';
import { handleLeaseApi, leasesPage, type LeaseEnv } from './leases.ts';

export { LeaseRoom } from './leases.ts';

interface ArtifactsRepo {
  info(): Promise<{ remote: string }>;
  createToken(scope?: 'read' | 'write', ttl?: number): Promise<Record<string, unknown>>;
}

interface Env extends AiEnv, LeaseEnv {
  ARTIFACTS: { get(name: string): Promise<ArtifactsRepo> };
  VIEWER: DurableObjectNamespace<Viewer>;
  REPO: string;
  VIEW_KEY: string;
  /** Comma-separated repos anyone may read without the key (GET pages only, no AI). */
  PUBLIC_REPOS?: string;
}

export class Viewer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
}

const COOKIE = 'pl_key';
const REPO_COOKIE = 'pl_repo';
const TOKEN_TTL_S = 3600;
const cached = new Map<string, { remote: string; token: string; until: number }>();

async function access(env: Env, name: string): Promise<{ remote: string; token: string }> {
  const hit = cached.get(name);
  if (hit && hit.until > Date.now()) return hit;
  const repo = await env.ARTIFACTS.get(name);
  const [{ remote }, t] = await Promise.all([repo.info(), repo.createToken('read', TOKEN_TTL_S)]);
  const token = String(t.plaintext ?? t.token ?? t.secret ?? '');
  if (!token) throw new Error('Artifacts returned no token');
  const entry = { remote, token, until: Date.now() + (TOKEN_TTL_S - 300) * 1000 };
  cached.set(name, entry);
  return entry;
}

const isRepoName = (s: string) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(s);
const cookieValue = (req: Request, name: string) =>
  (req.headers.get('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const isPublic = (env: Env, name: string) => (env.PUBLIC_REPOS ?? '').split(',').map((s) => s.trim()).includes(name);

function hasKey(req: Request, env: Env): boolean {
  const cookie = req.headers.get('cookie') ?? '';
  return cookie.split(/;\s*/).some((c) => c === `${COOKIE}=${env.VIEW_KEY}`);
}

const denied = () =>
  new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>promptlog</title><p style="font:16px system-ui;padding:24px">This review link is private. Open it with the full link you were sent.</p>', {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const readOnly = () => new Response('This demo is read-only.\n', { status: 405, headers: { 'content-type': 'text/plain', allow: 'GET, HEAD' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.VIEW_KEY) return new Response('VIEW_KEY is not set', { status: 500 });
    const url = new URL(req.url);

    // The container's AI calls (Clef, Gemini) come back through here; they carry their own key, not the cookie.
    if (url.pathname.startsWith('/__ai/')) return handleAi(req, env, await aiKey(env.VIEW_KEY));
    // Agents' lease calls carry a per-repo key, not the cookie.
    if (url.pathname.startsWith('/__leases/')) return handleLeaseApi(req, env, isRepoName);

    // ?key=… once: store it in a cookie and drop it from the address bar.
    const key = url.searchParams.get('key');
    if (key !== null) {
      if (key !== env.VIEW_KEY) return denied();
      url.searchParams.delete('key');
      return new Response(null, {
        status: 302,
        headers: {
          location: url.pathname + url.search,
          'set-cookie': `${COOKIE}=${env.VIEW_KEY}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    const keyed = hasKey(req, env);

    // ?repo=<name> picks which Artifacts repo this browser looks at, and remembers it; the default is REPO.
    const pick = url.searchParams.get('repo');
    if (pick !== null && !isRepoName(pick)) return new Response('not a repo name\n', { status: 400 });
    const repoCookie = (n: string) => `${REPO_COOKIE}=${n}; Path=/; Max-Age=2592000; Secure; SameSite=Lax`;
    if (keyed && pick !== null) {
      url.searchParams.delete('repo');
      return new Response(null, { status: 302, headers: { location: url.pathname + url.search, 'set-cookie': repoCookie(pick) } });
    }
    const chosen = cookieValue(req, REPO_COOKIE);
    const name = pick ?? (chosen && isRepoName(chosen) ? chosen : env.REPO);

    // Without the key: public repos only, and only reading pages. Everything else (other repos, /__restart, /__log,
    // asks, AI) needs the key. `name` is the only repo this request can touch, so whatever link or cookie a visitor
    // brings, a private repo is refused here.
    if (!keyed) {
      if (!isPublic(env, name)) return denied();
      if (url.pathname.startsWith('/__')) return denied();
      if (req.method !== 'GET' && req.method !== 'HEAD') return readOnly();
    }

    // Who's working on what: the repo's shared lease table. Only key holders see how to connect another machine.
    if (url.pathname === '/leases' && (req.method === 'GET' || req.method === 'HEAD')) {
      const res = await leasesPage(env, name, url.origin, keyed);
      if (pick !== null) res.headers.append('set-cookie', repoCookie(pick));
      return res;
    }

    const container = env.VIEWER.getByName(name);
    // A running container keeps its image across deploys; this restarts it on the latest one.
    if (url.pathname === '/__restart') {
      await container.destroy();
      return new Response('restarted; the next page load starts a fresh container\n', { headers: { 'content-type': 'text/plain' } });
    }

    let repoAccess;
    try {
      repoAccess = await access(env, name);
    } catch {
      return new Response(`No repo named "${name}". Open /?repo=<name> with one that exists.\n`, { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const { remote, token } = repoAccess;
    const headers = new Headers(req.headers);
    headers.delete('cookie');
    for (const h of ['x-artifacts-remote', 'x-artifacts-token', 'x-ai-base', 'x-ai-key']) headers.delete(h);
    headers.set('x-artifacts-remote', remote);
    headers.set('x-artifacts-token', token);
    // A public repo's container gets the AI key only to write its own summaries (the overview and per-turn notes, read
    // with GET). Its content is fixed and those results are cached, so a visitor can't spend more than one write each.
    // Asks (POST) stay refused above, and /__ai/* needs the key.
    const summaryRead = req.method === 'GET' && (url.pathname === '/api/overview' || url.pathname === '/api/glance');
    if (!isPublic(env, name) || summaryRead) {
      headers.set('x-ai-base', `${url.origin}/__ai`);
      headers.set('x-ai-key', await aiKey(env.VIEW_KEY));
    }
    const res = await container.fetch(new Request(req, { headers }));
    if (pick === null) return res;
    // A public visitor came with ?repo=: serve the page itself, and remember the repo so its links stay on it.
    const out = new Response(res.body, res);
    out.headers.append('set-cookie', repoCookie(pick));
    return out;
  },
};
