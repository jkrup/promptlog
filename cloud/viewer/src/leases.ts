// Leases shared by agents on different machines. One Durable Object per repo holds the lease table, with the same
// rules as the local file (src/capture/lease-table.ts): a session that tries to edit a block (or a file) another live
// session holds is refused and told who holds it. When two agents' blocks are next to each other, or the block's holder
// has been quiet for a while, the object asks Clef-flash (Workers AI) whether the two changes are independent, within a
// time budget, and code decides (src/capture/lease-judge.ts). The last 50 verdicts are kept and shown on /leases.
//
//   agent hook --(POST /__leases/<repo>/<op>, Bearer key)--> Worker --> LeaseRoom "<repo>" (--> Clef-flash)
//   browser ----(GET /leases, cookie)----------------------> Worker --> LeaseRoom "<repo>" --> who's working on what
//
// The key is per repo, HMAC(VIEW_KEY, "leases:<repo>"): it can claim and release leases in that repo and nothing else.
import { DurableObject } from 'cloudflare:workers';
import { claimJudged, JUDGE_BUDGET_MS, type Judge } from '../../../src/capture/lease-judge.ts';
import { applyOp, DEFAULT_TTL_MS, MAX_LEASES, parseOp, prune, type Decision, type Lease, type LeaseOp, type Table } from '../../../src/capture/lease-table.ts';
import { renderLeasesPage } from '../../../src/viewer/leases-page.ts';
import { clef, derivedKey, type AiEnv } from './ai.ts';

export interface LeaseEnv extends AiEnv {
  LEASES: DurableObjectNamespace<LeaseRoom>;
  VIEW_KEY: string;
  /** Minutes without activity before a lease ends; default 15. */
  LEASE_TTL_MIN?: string;
  /** How long a gray-zone claim waits for Clef, in ms; default 1500. */
  LEASE_JUDGE_MS?: string;
}

const ttlMs = (env: LeaseEnv) => {
  const n = Number(env.LEASE_TTL_MIN);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : DEFAULT_TTL_MS;
};

const judgeMs = (env: LeaseEnv) => {
  const n = Number(env.LEASE_JUDGE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2500) : JUDGE_BUDGET_MS;
};

/** Clef-flash through the Worker's AI binding, in the same Jev shape as everywhere else. */
const clefJudge = (env: AiEnv): Judge | null => (env.AI ? (req) => clef(env, { model: 'clef-flash', state: req.state, questions: req.questions }) as ReturnType<Judge> : null);

class TableFull extends Error {}

export class LeaseRoom extends DurableObject<LeaseEnv> {
  private async load(): Promise<Table> {
    const got = await this.ctx.storage.get<Lease[] | Decision[]>(['leases', 'decisions']);
    return { leases: (got.get('leases') as Lease[] | undefined) ?? [], decisions: (got.get('decisions') as Decision[] | undefined) ?? [] };
  }

  /** One operation on this repo's table. Storage calls hold the object's input gate, so each step runs one at a time. */
  async run(op: LeaseOp, ttl: number): Promise<{ status: number; body: unknown }> {
    if (op.op === 'claim') {
      // Claim, ask Clef about gray-zone cases (other requests may run meanwhile), claim again with the verdicts.
      const store = {
        update: async <T>(fn: (t: Table, now: number) => T): Promise<T> => {
          const t = await this.load();
          prune(t.leases, Date.now(), ttl);
          const out = fn(t, Date.now());
          if (t.leases.length > MAX_LEASES) throw new TableFull();
          await this.ctx.storage.put({ leases: t.leases, decisions: t.decisions });
          return out;
        },
      };
      try {
        const body = await claimJudged(store, op.holder, op, { force: op.force, keepBlocks: op.keepBlocks, judge: clefJudge(this.env), budgetMs: judgeMs(this.env), noJudge: 'no AI binding' });
        return { status: 200, body };
      } catch (err) {
        if (err instanceof TableFull) return { status: 507, body: { error: `the lease table is full (${MAX_LEASES} leases)` } };
        throw err;
      }
    }
    const t = await this.load();
    const { reply, changed } = applyOp(t, op, Date.now(), ttl);
    if (changed) await this.ctx.storage.put({ leases: t.leases, decisions: t.decisions });
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
  // A claim can carry the text of the file being edited (up to 200k characters), so other agents' blocks can be found in it.
  if (Number(req.headers.get('content-length') ?? 0) > 1024 * 1024) return json(413, { error: 'request too large' });
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
  const { leases = [], decisions = [] } = r.body as { leases?: Lease[]; decisions?: Decision[] };
  const join = withJoin
    ? { command: `promptlog connect --no-backfill --leases ${origin}/__leases/${repo} --leases-key ${await leaseKey(env.VIEW_KEY, repo)}` }
    : undefined;
  const page = renderLeasesPage({ repo, leases, decisions, now: Date.now(), ttlMin: Math.round(ttlMs(env) / 60_000), join, note: 'This page refreshes every 20 seconds.' });
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', refresh: '20', 'referrer-policy': 'no-referrer' } });
}
