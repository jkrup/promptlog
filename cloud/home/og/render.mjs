// Renders the link card and icons into ../public:
//   og.png (1200x630, from og/index.html), apple-touch-icon.png (180), favicon-32.png (32, from public/favicon.svg).
// Needs the `playwright` package and its Chromium. Usage, from cloud/home:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node og/render.mjs   (or plain `node og/render.mjs` if playwright resolves)
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' });
await p.goto(pathToFileURL(join(here, 'index.html')).href, { waitUntil: 'networkidle' });
await p.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
await p.screenshot({ path: join(pub, 'img', 'og.png') });
for (const [name, size] of [['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  const q = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await q.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${pathToFileURL(join(pub, 'favicon.svg')).href}">`);
  await q.waitForLoadState('networkidle');
  await q.screenshot({ path: join(pub, name), omitBackground: true });
}
await b.close();
console.log('wrote public/img/og.png, public/apple-touch-icon.png, public/favicon-32.png');
