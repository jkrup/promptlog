// Saves the public hosted /leases page (no key needed) as a static file for the video, since leases expire
// after 15 quiet minutes. Scripts are dropped so the page stays as captured. Writes demo/build/leases-web.html.
import { chromium } from 'playwright';
import fs from 'node:fs';
const PAGE = process.argv[2] ?? 'https://promptlog-viewer.mazlix-f8e.workers.dev/leases?repo=promptlog-demo';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(PAGE, { waitUntil: 'networkidle' });
let html = await p.content();
html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]*http-equiv="refresh"[^>]*>/gi, '');
fs.mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./build/leases-web.html', import.meta.url), html);
console.log(`saved ${html.length} bytes from ${PAGE} at ${new Date().toISOString()}`);
await b.close();
