// promptlog's review page on Cloudflare: a Worker in front of a Container that runs the stock `promptlog view`
// against a clone of an Artifacts repo. Open it on any device with the secret link.
//
//   phone --> Worker (checks the key, mints a read token) --> Container (git fetch from Artifacts + promptlog view)
import { Container } from '@cloudflare/containers';
import { aiKey, handleAi, type AiEnv } from './ai.ts';

interface ArtifactsRepo {
  info(): Promise<{ remote: string }>;
  createToken(scope?: 'read' | 'write', ttl?: number): Promise<Record<string, unknown>>;
}

interface Env extends AiEnv {
  ARTIFACTS: { get(name: string): Promise<ArtifactsRepo> };
  VIEWER: DurableObjectNamespace<Viewer>;
  REPO: string;
  VIEW_KEY: string;
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

function hasKey(req: Request, env: Env): boolean {
  const cookie = req.headers.get('cookie') ?? '';
  return cookie.split(/;\s*/).some((c) => c === `${COOKIE}=${env.VIEW_KEY}`);
}

const denied = () =>
  new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>promptlog</title><p style="font:16px system-ui;padding:24px">This review link is private. Open it with the full link you were sent.</p>', {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.VIEW_KEY) return new Response('VIEW_KEY is not set', { status: 500 });
    const url = new URL(req.url);

    // The container's AI calls (Clef, Gemini) come back through here; they carry their own key, not the cookie.
    if (url.pathname.startsWith('/__ai/')) return handleAi(req, env, await aiKey(env.VIEW_KEY));

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
    if (!hasKey(req, env)) return denied();

    // ?repo=<name> picks which Artifacts repo this browser looks at, and remembers it; the default is REPO.
    const pick = url.searchParams.get('repo');
    if (pick !== null) {
      if (!isRepoName(pick)) return new Response('not a repo name\n', { status: 400 });
      url.searchParams.delete('repo');
      return new Response(null, {
        status: 302,
        headers: { location: url.pathname + url.search, 'set-cookie': `${REPO_COOKIE}=${pick}; Path=/; Max-Age=2592000; Secure; SameSite=Lax` },
      });
    }
    const chosen = cookieValue(req, REPO_COOKIE);
    const name = chosen && isRepoName(chosen) ? chosen : env.REPO;

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
    headers.set('x-artifacts-remote', remote);
    headers.set('x-artifacts-token', token);
    headers.set('x-ai-base', `${url.origin}/__ai`);
    headers.set('x-ai-key', await aiKey(env.VIEW_KEY));
    return container.fetch(new Request(req, { headers }));
  },
};
