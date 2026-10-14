// A stand-in for the Cloudflare lease table (cloud/viewer/src/leases.ts) in tests: the same routes, key check, table
// rules (src/capture/lease-table.ts) and Clef step (src/capture/lease-judge.ts), in memory, with a fake Clef. Run as a
// child process: `node test/lease-server.ts <key> [--hang] [--clef <choice>:<p> | --clef hang] [--budget <ms>]
// [--log <file>]`; prints the port. With --hang it never answers (for timeout tests). --log appends each request Clef
// gets, one JSON line each.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { claimJudged, type Judge } from '../src/capture/lease-judge.ts';
import { applyOp, DEFAULT_TTL_MS, parseOp, prune, type Table } from '../src/capture/lease-table.ts';

const key = process.argv[2] ?? '';
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const hang = process.argv.includes('--hang');
const clef = flag('--clef');
const budgetMs = Number(flag('--budget') ?? 1500);
const log = flag('--log');
const tables = new Map<string, Table>();

/** The fake Clef: always the same answer, or never an answer. */
const judge: Judge | null = !clef
  ? null
  : async (req, signal) => {
      if (log) appendFileSync(log, JSON.stringify(req) + '\n');
      if (clef === 'hang') return new Promise((_, fail) => signal.addEventListener('abort', () => fail(new Error('aborted'))));
      const [choice, p] = clef.split(':');
      const rest = (1 - Number(p)) / 2;
      const probabilities = Object.fromEntries(['independent', 'conflicting', 'unsure'].map((c) => [c, c === choice ? Number(p) : rest]));
      return { model: '@cf/cloudflare/clef-flash', answers: { verdict: { type: 'choice', choice, probabilities, confidence: Number(p) } } };
    };

const server = createServer((req, res) => {
  if (hang) return;
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const send = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const m = /^\/__leases\/([a-z0-9-]+)(?:\/([a-z]+))?$/.exec(req.url ?? '');
    if (!m) return send(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: 'bad key' });
    let parsed: unknown = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      return send(400, { error: 'invalid JSON' });
    }
    const op = parseOp(m[2] ?? 'list', parsed);
    if (typeof op === 'string') return send(400, { error: op });
    const table = tables.get(m[1]!) ?? { leases: [], decisions: [] };
    tables.set(m[1]!, table);
    if (op.op !== 'claim') return send(200, applyOp(table, op, Date.now()).reply);
    const store = {
      update: async <T>(fn: (t: Table, now: number) => T) => {
        prune(table.leases, Date.now(), DEFAULT_TTL_MS);
        return fn(table, Date.now());
      },
    };
    send(200, await claimJudged(store, op.holder, op, { force: op.force, keepBlocks: op.keepBlocks, judge, budgetMs, noJudge: 'no Clef here' }));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${(server.address() as AddressInfo).port}\n`));
