// A stand-in for the Cloudflare lease table (cloud/viewer/src/leases.ts) in tests: the same routes, key check and
// table rules (src/capture/lease-table.ts), in memory. Run as a child process: `node test/lease-server.ts <key>
// [--hang]`; prints the port. With --hang it never answers (for timeout tests).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyOp, parseOp, type Lease } from '../src/capture/lease-table.ts';

const key = process.argv[2] ?? '';
const hang = process.argv.includes('--hang');
const tables = new Map<string, Lease[]>();

const server = createServer((req, res) => {
  if (hang) return;
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
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
    const table = tables.get(m[1]!) ?? [];
    tables.set(m[1]!, table);
    send(200, applyOp(table, op, Date.now()).reply);
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${(server.address() as AddressInfo).port}\n`));
