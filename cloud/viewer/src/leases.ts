// Leases shared by agents on different machines. One Durable Object per repo holds the lease table, with the same
// rules as the local file (src/capture/lease-table.ts): a session that tries to edit a file another live session holds
// is refused and told who holds it.
//
//   agent hook --(POST /__leases/<repo>/<op>, Bearer key)--> Worker --> LeaseRoom "<repo>"
//   browser ----(GET /leases, cookie)----------------------> Worker --> LeaseRoom "<repo>" --> who's working on what
//
// The key is per repo, HMAC(VIEW_KEY, "leases:<repo>"): it can claim and release leases in that repo and nothing else.
import { DurableObject } from 'cloudflare:workers';
import { applyOp, DEFAULT_TTL_MS, MAX_LEASES, parseOp, type Lease, type LeaseOp } from '../../../src/capture/lease-table.ts';
import { renderLeasesPage } from '../../../src/viewer/leases-page.ts';
import { derivedKey } from './ai.ts';

export interface LeaseEnv {
  LEASES: DurableObjectNamespace<LeaseRoom>;
  VIEW_KEY: string;
  /** Minutes without activity before a lease ends; default 15. */
  LEASE_TTL_MIN?: string;
}

const ttlMs = (env: LeaseEnv) => {
  const n = Number(env.LEASE_TTL_MIN);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : DEFAULT_TTL_MS;
};

export class LeaseRoom extends DurableObject {
  /** One operation on this repo's table. Storage calls hold the object's input gate, so this runs one at a time. */
  async run(op: LeaseOp, ttl: number): Promise<{ status: number; body: unknown }> {
    const leases = (await this.ctx.storage.get<Lease[]>('leases')) ?? [];
    const { reply, changed } = applyOp(leases, op, Date.now(), ttl);
    if (leases.length > MAX_LEASES) return { status: 507, body: { error: `the lease table is full (${MAX_LEASES} files)` } };
    if (changed) await this.ctx.storage.put('leases', leases);
    return { status: 200, body: reply };
  }
}

export const leaseKey = (viewKey: string, repo: string) => derivedKey(viewKey, `leases:${repo}`);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function sameKey(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** /__leases/<repo>[/<op>]: list (GET or POST), claim, renew, release (POST, JSON body). */
export async function handleLeaseApi(req: Request, env: LeaseEnv, isRepoName: (s: string) => boolean): Promise<Response> {
  const m = /^\/__leases\/([^/]+)(?:\/([a-z]+))?\/?$/.exec(new URL(req.url).pathname);
  if (!m || !isRepoName(m[1]!)) return json(404, { error: 'use /__leases/<repo>/<list|claim|renew|release>' });
  const repo = m[1]!;
  const opName = m[2] ?? 'list';
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!(await sameKey(given, await leaseKey(env.VIEW_KEY, repo)))) return json(401, { error: 'bad key' });
  if (req.method !== 'POST' && !(req.method === 'GET' && opName === 'list')) return json(405, { error: 'use POST' });
  if (Number(req.headers.get('content-length') ?? 0) > 256 * 1024) return json(413, { error: 'request too large' });
  let body: unknown = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'invalid JSON' });
    }
  }
  const op = parseOp(opName, body);
  if (typeof op === 'string') return json(400, { error: op });
  const r = await env.LEASES.getByName(repo).run(op, ttlMs(env));
  return json(r.status, r.body);
}

/** The "who's working on what" page for `repo`. `withJoin` adds the command that connects another machine (it shows the key). */
export async function leasesPage(env: LeaseEnv, repo: string, origin: string, withJoin: boolean): Promise<Response> {
  const r = await env.LEASES.getByName(repo).run({ op: 'list' }, ttlMs(env));
  const leases = (r.body as { leases?: Lease[] }).leases ?? [];
  const join = withJoin
    ? { command: `promptlog connect --no-backfill --leases ${origin}/__leases/${repo} --leases-key ${await leaseKey(env.VIEW_KEY, repo)}` }
    : undefined;
  const page = renderLeasesPage({ repo, leases, now: Date.now(), ttlMin: Math.round(ttlMs(env) / 60_000), join, note: 'This page refreshes every 20 seconds.' });
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', refresh: '20', 'referrer-policy': 'no-referrer' } });
}
