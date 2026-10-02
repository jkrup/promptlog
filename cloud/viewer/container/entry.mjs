// Runs inside the container. Keeps a clone of the Artifacts repo fresh and fronts the stock `promptlog view` server.
//
//   Worker --(X-Artifacts-Token, X-Artifacts-Remote)--> :8080 this proxy --> 127.0.0.1:4777 promptlog view
//
// promptlog view only listens on 127.0.0.1 and refuses foreign Host/Origin headers (DNS-rebinding guard), so the
// proxy rewrites both. The Worker mints a short-lived read token per request; nothing secret is stored here.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import http from 'node:http';

const REPO = '/repo';
const VIEW_PORT = 4777;
const FETCH_EVERY_MS = 10_000;

let lastFetch = 0;
let fetching = null;
let viewer = null;
// Last lines of the viewer's output and the proxy's own errors, served at /__log (behind the Worker's key check).
const logLines = [];
const log = (line) => {
  logLines.push(`${new Date().toISOString()} ${line}`);
  if (logLines.length > 300) logLines.shift();
  console.log(line);
};

// Errors carry only git's stderr: execFileSync's own message includes the command line, and with it the token.
const git = (args, token) => {
  try {
    return execFileSync('git', ['-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args], { cwd: REPO, stdio: 'pipe', timeout: 120_000 });
  } catch (e) {
    const stderr = String(e?.stderr ?? '').split(token).join('[token]').trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

function sync(remote, token) {
  if (!existsSync(`${REPO}/.git`)) {
    execFileSync('git', ['init', '-q', REPO]);
    execFileSync('git', ['config', 'user.name', 'promptlog viewer'], { cwd: REPO });
    execFileSync('git', ['config', 'user.email', 'viewer@promptlog.invalid'], { cwd: REPO });
  }
  // Mirror branches and promptlog refs as local refs, which is what `promptlog view` reads. --update-head-ok:
  // HEAD points at main, and nothing is checked out, so overwriting it is fine.
  git(['fetch', '-q', '--prune', '--force', '--update-head-ok', remote, '+refs/heads/*:refs/heads/*', '+refs/promptlog/*:refs/promptlog/*'], token);
  try {
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: REPO });
  } catch {}
  lastFetch = Date.now();
}

async function ensureFresh(remote, token) {
  if (!remote || !token) return;
  if (Date.now() - lastFetch < FETCH_EVERY_MS && existsSync(`${REPO}/.git`)) return;
  fetching ??= Promise.resolve()
    .then(() => sync(remote, token))
    .finally(() => (fetching = null));
  await fetching;
}

// promptlog's quick-ask clients read ~/.config/promptlog/config.json on every call. Point both at the Worker,
// which runs Clef (decisions) and Gemini via AI Gateway (text) with its own binding: no provider keys in here.
let aiConfigFor = '';
function writeAiConfig(base, key) {
  if (!base || !key || aiConfigFor === `${base} ${key}`) return;
  const dir = `${homedir()}/.config/promptlog`;
  mkdirSync(dir, { recursive: true });
  const config = {
    decision: { url: `${base}/systemone`, apiKey: key, model: '@cf/cloudflare/clef-flash' },
    // Text on Workers AI (no credits needed). Set TEXT_MODEL to e.g. 'gemini-3.8-flash' to use AI Gateway instead.
    gemini: { url: `${base}/gemini`, apiKey: key, model: process.env.TEXT_MODEL || '@cf/deepseek-ai/deepseek-v4-flash-0731' },
  };
  writeFileSync(`${dir}/config.json`, JSON.stringify(config, null, 2), { mode: 0o600 });
  aiConfigFor = `${base} ${key}`;
}

function startViewer() {
  if (viewer) return;
  viewer = spawn('/app/bin/promptlog', ['view', '--port', String(VIEW_PORT)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [viewer.stdout, viewer.stderr]) s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(`viewer: ${l}`)));
  viewer.on('exit', (code, signal) => {
    log(`promptlog view exited (code ${code}, signal ${signal}); restarting on next request`);
    viewer = null;
  });
}

async function waitForViewer() {
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => {
      const req = http.get({ host: '127.0.0.1', port: VIEW_PORT, path: '/favicon.ico' }, (res) => (res.resume(), r(true)));
      req.on('error', () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('promptlog view did not start');
}

http
  .createServer(async (req, res) => {
    if (req.url === '/__log') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(logLines.join('\n') + '\n');
      return;
    }
    try {
      await ensureFresh(req.headers['x-artifacts-remote'], req.headers['x-artifacts-token']);
      if (!existsSync(`${REPO}/.git`)) throw new Error('repository not fetched yet');
      writeAiConfig(req.headers['x-ai-base'], req.headers['x-ai-key']);
      startViewer();
      await waitForViewer();
      const headers = { ...req.headers, host: `127.0.0.1:${VIEW_PORT}` };
      delete headers['x-artifacts-token'];
      delete headers['x-artifacts-remote'];
      delete headers['x-ai-base'];
      delete headers['x-ai-key'];
      if (headers.origin) headers.origin = `http://127.0.0.1:${VIEW_PORT}`;
      const up = http.request({ host: '127.0.0.1', port: VIEW_PORT, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => {
        log(`proxy: ${req.method} ${req.url} -> ${e.message}`);
        res.writeHead(502, { 'content-type': 'text/plain' }).end(`viewer error: ${e.message}`);
      });
      req.pipe(up);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`container error: ${e instanceof Error ? e.message : String(e)}`);
    }
  })
  .listen(8080, '0.0.0.0', () => console.log('promptlog container proxy on :8080'));
