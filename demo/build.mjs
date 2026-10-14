// Builds the promptlog demo video.
//   node demo/build.mjs                 narrate + render every scene, then assemble
//   node demo/build.mjs review-t13 arch only (re)render these scenes, then assemble
//   node demo/build.mjs --assemble      only assemble existing segments
//   node demo/build.mjs --stills        one PNG per narrated sentence (quick look), no video
// Needs: macOS `say`, ffmpeg, the Playwright chromium-1243 cache, and for the live scenes the viewer:
//   node demo/serve.ts <clone-of-browser-use> 4812   (demo/render.sh sets that up and runs this)
// Every frame is rendered deterministically (set time t, screenshot), so timing matches narration exactly.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { CONFIG, ORDER, SCENES } from './script.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const BUILD = path.join(DIR, 'build');
const OUT = path.join(DIR, 'out');
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FPS = 30;
const SR = 48000;
const SPF = SR / FPS; // audio samples per video frame (1600)
const W = 1280, H = 720, DPR = 1.5;
const OVERLAY = fs.readFileSync(path.join(DIR, 'overlay.js'), 'utf8');

fs.mkdirSync(path.join(BUILD, 'tts'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const assembleOnly = args.includes('--assemble');
const stills = args.includes('--stills');
const only = args.filter((a) => !a.startsWith('--'));
for (const id of only) if (!SCENES[id]) throw new Error(`unknown scene: ${id}`);

// ---------- narration ----------
const norm = (s) => (typeof s === 'string' ? { say: s, cap: s } : s);

function tts(text) {
  const key = createHash('sha1').update(`${CONFIG.voice}|${CONFIG.rate}|${text}`).digest('hex').slice(0, 16);
  const pcm = path.join(BUILD, 'tts', `${key}.pcm`);
  if (!fs.existsSync(pcm)) {
    const aiff = path.join(BUILD, 'tts', `${key}.aiff`);
    execFileSync('say', ['-v', CONFIG.voice, '-r', String(CONFIG.rate), '-o', aiff, '--', text]);
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', aiff, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', '-f', 's16le', '-ac', '1', '-ar', String(SR), pcm]);
    fs.unlinkSync(aiff);
  }
  return fs.readFileSync(pcm);
}

/** Lays out one scene's audio: lead silence, sentences with gaps, tail. Returns timing + PCM padded to whole frames. */
function narrate(sc) {
  const lead = sc.lead ?? 0.7, gap = sc.gap ?? 0.45, tail = sc.tail ?? 0.9;
  const parts = [];
  const cues = [], ends = [];
  let t = lead;
  parts.push(Buffer.alloc(Math.round(lead * SR) * 2));
  sc.sentences.map(norm).forEach((s, i) => {
    const pcm = tts(s.say);
    cues.push(t);
    t += pcm.length / 2 / SR;
    ends.push(t);
    parts.push(pcm);
    const g = i < sc.sentences.length - 1 ? (s.pause ?? gap) : tail;
    parts.push(Buffer.alloc(Math.round(g * SR) * 2));
    t += Math.round(g * SR) / SR;
  });
  let pcm = Buffer.concat(parts);
  const frames = Math.max(Math.ceil(pcm.length / 2 / SPF), Math.ceil((sc.minDur ?? 0) * FPS));
  const want = frames * SPF * 2;
  if (pcm.length < want) pcm = Buffer.concat([pcm, Buffer.alloc(want - pcm.length)]);
  return { cues, ends, frames, dur: frames / FPS, pcm };
}

/** Caption chunks: long sentences are split at punctuation near the middle, timed by length. */
function captions(sc, timing) {
  const out = [];
  sc.sentences.map(norm).forEach((s, i) => {
    const a = timing.cues[i], b = timing.ends[i];
    const chunks = splitCap(s.cap);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    let x = a;
    for (const c of chunks) {
      const d = ((b - a) * c.length) / total;
      out.push({ from: x, to: x + d, text: c });
      x += d;
    }
  });
  // Keep each caption up until the next starts (no flicker in short gaps).
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].from - out[i].to < 0.8) out[i].to = out[i + 1].from;
  return out;
}

function splitCap(s, max = 118) {
  if (s.length <= max) return [s];
  const mid = s.length / 2;
  let best = -1;
  const re = /[.:;?!,](\s)/g;
  let m;
  while ((m = re.exec(s))) {
    const i = m.index + 1;
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  if (best < 0) {
    best = s.lastIndexOf(' ', mid);
  }
  return [...splitCap(s.slice(0, best).trim(), max), ...splitCap(s.slice(best).trim(), max)];
}

// ---------- rendering ----------
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (x) => Math.max(0, Math.min(1, x));

async function resolveY(page, target, offset = 0) {
  return page.evaluate(
    ({ target, offset }) => {
      const max = document.documentElement.scrollHeight - innerHeight;
      let y;
      if (typeof target === 'number') y = target;
      else if (target && typeof target === 'object' && 'by' in target) y = scrollY + target.by;
      else {
        const el = document.querySelector(target);
        if (!el) throw new Error('no element for scroll: ' + target);
        y = el.getBoundingClientRect().top + scrollY + offset;
      }
      return Math.max(0, Math.min(max, y));
    },
    { target, offset },
  );
}

async function centerOf(page, sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element for click: ' + sel);
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 };
  }, sel);
}

async function renderScene(browser, id, timing, ctxData) {
  const sc = SCENES[id];
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, bypassCSP: true, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(sc.url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(
    ({ cues, ends, dur }) => {
      window.CUES = cues;
      window.ENDS = ends;
      window.END = dur;
    },
    timing,
  );
  await page.addScriptTag({ content: OVERLAY });
  if (sc.setup) await sc.setup(page, ctxData);
  let y = 0;
  if (sc.start) y = 'y' in sc.start ? sc.start.y : await resolveY(page, sc.start.sel, sc.start.offset ?? 0);
  await page.evaluate((y) => window.scrollTo(0, y), y);

  const caps = captions(sc, timing);
  const t = {
    cues: timing.cues,
    ends: timing.ends,
    dur: timing.dur,
    c: (i, d = 0) => timing.cues[i] + d,
    e: (i, d = 0) => timing.ends[i] + d,
  };
  const steps = (sc.timeline ? sc.timeline(t) : []).map((s, i) => ({ ...s, i, done: false }));
  // cursor: starts off-screen bottom-right, glides to click targets
  let cur = null; // {x,y}
  let curFrom = null, curTo = null, curT0 = 0, curT1 = 0, clickAt = -1, cursorHidden = false;
  let scrollAnim = null; // {from,to,t0,t1}

  const enc = stills ? null : spawn(FFMPEG, ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', path.join(BUILD, `seg-${id}.mp4`)], { stdio: ['pipe', 'inherit', 'inherit'] });
  let lastSig = null, buf = null, shots = 0;
  const stillTimes = stills ? new Set(timing.cues.map((c, i) => Math.min(timing.frames - 1, Math.round(((c + timing.ends[i]) / 2) * FPS)))) : null;

  for (let f = 0; f < timing.frames; f++) {
    const now = f / FPS;
    // start steps whose time has come
    for (const s of steps) {
      if (s.done || now < (s.click ? s.at - (s.move ?? 0.7) : s.at)) continue;
      if (s.scroll !== undefined) {
        s.done = true;
        const to = await resolveY(page, s.scroll, s.offset ?? 0);
        scrollAnim = { from: y, to, t0: s.at, t1: s.at + (s.dur ?? 1.2) };
      } else if (s.cursor === 'hide') {
        s.done = true;
        cursorHidden = true;
      } else if (s.click) {
        if (!s.moving) {
          s.moving = true;
          const target = await centerOf(page, s.click);
          curFrom = cur ?? { x: W - 160, y: H - 40 };
          curTo = target;
          curT0 = s.at - (s.move ?? 0.7);
          curT1 = s.at;
          cursorHidden = false;
        }
        if (now >= s.at) {
          s.done = true;
          await page.evaluate((sel) => document.querySelector(sel).click(), s.click);
          clickAt = s.at;
          y = await page.evaluate(() => scrollY);
          scrollAnim = null;
        }
      } else if (s.hl) {
        // handled per frame below
      }
    }
    if (scrollAnim) {
      const p = clamp((now - scrollAnim.t0) / Math.max(0.001, scrollAnim.t1 - scrollAnim.t0));
      y = scrollAnim.from + (scrollAnim.to - scrollAnim.from) * ease(p);
      if (p >= 1) scrollAnim = null;
    }
    if (curTo) {
      const p = clamp((now - curT0) / Math.max(0.001, curT1 - curT0));
      cur = { x: curFrom.x + (curTo.x - curFrom.x) * ease(p), y: curFrom.y + (curTo.y - curFrom.y) * ease(p) };
    }
    const hls = steps
      .filter((s) => s.hl && now >= s.at && now < (s.until ?? Infinity))
      .map((s) => {
        const fadeIn = clamp((now - s.at) / 0.3);
        const fadeOut = s.until ? clamp((s.until - now) / 0.3) : 1;
        return { sel: s.hl, o: Math.round(Math.min(fadeIn, fadeOut) * 20) / 20, label: s.label, pad: s.pad, dim: s.dim, below: s.below };
      });
    const cap = caps.find((c) => now >= c.from && now < c.to)?.text ?? '';
    const ringP = clickAt >= 0 ? (now - clickAt) / 0.45 : -1;
    const state = {
      t: now,
      y: Math.round(y),
      cap,
      badge: sc.badge || '',
      badgePos: sc.badgePos || 'right',
      hls,
      cur: cur && !cursorHidden ? { x: cur.x, y: cur.y, down: clickAt >= 0 && now - clickAt < 0.15, ring: ringP > 0 && ringP < 1 ? Math.round(ringP * 20) / 20 : 0 } : null,
    };
    const sig = await page.evaluate((s) => window.__ovApply(s), state);
    if (stills) {
      if (stillTimes.has(f)) {
        await page.screenshot({ path: path.join(BUILD, 'stills', `${id}-${String(f).padStart(5, '0')}.png`) });
        shots++;
      }
      continue;
    }
    if (sig !== lastSig) {
      buf = await page.screenshot({ type: 'jpeg', quality: 93 });
      lastSig = sig;
      shots++;
    }
    if (!enc.stdin.write(buf)) await once(enc.stdin, 'drain');
  }
  await ctx.close();
  if (enc) {
    enc.stdin.end();
    const [code] = await once(enc, 'close');
    if (code !== 0) throw new Error(`ffmpeg failed for ${id}`);
  }
  return shots;
}

function writeWav(file, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

async function main() {
  const lease = (() => {
    const deny = path.join(BUILD, 'lease', 'deny.json');
    if (!fs.existsSync(deny)) return null;
    const clef = path.join(BUILD, 'lease', 'clef.json');
    const next = fs.existsSync(clef) && fs.statSync(clef).size ? JSON.parse(fs.readFileSync(clef, 'utf8')).hookSpecificOutput : {};
    return {
      reason: JSON.parse(fs.readFileSync(deny, 'utf8')).hookSpecificOutput.permissionDecisionReason,
      headsUp: next.additionalContext ?? next.permissionDecisionReason ?? '',
      table: fs.readFileSync(path.join(BUILD, 'lease', 'leases.txt'), 'utf8').trimEnd(),
    };
  })();
  const timings = {};
  for (const id of ORDER) {
    timings[id] = narrate(SCENES[id]);
    writeWav(path.join(BUILD, `seg-${id}.wav`), timings[id].pcm);
  }
  if (!assembleOnly) {
    if (stills) fs.mkdirSync(path.join(BUILD, 'stills'), { recursive: true });
    const todo = only.length ? only : ORDER;
    const browser = await chromium.launch();
    for (const id of todo) {
      const t0 = Date.now();
      const shots = await renderScene(browser, id, timings[id], { lease });
      console.log(`${id}: ${timings[id].dur.toFixed(1)}s, ${timings[id].frames} frames, ${shots} captured, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await browser.close();
    if (stills) return;
  }
  // assemble: concat video segments (copy), concat audio (exact), mux once
  const list = ORDER.map((id) => `file '${path.join(BUILD, `seg-${id}.mp4`)}'`).join('\n');
  fs.writeFileSync(path.join(BUILD, 'concat.txt'), list + '\n');
  writeWav(path.join(BUILD, 'all.wav'), Buffer.concat(ORDER.map((id) => timings[id].pcm)));
  const out = path.join(OUT, 'promptlog-demo.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(BUILD, 'concat.txt'), '-i', path.join(BUILD, 'all.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'volume=-1.5dB', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
  // captions file next to the video
  let srt = '', n = 0, off = 0;
  for (const id of ORDER) {
    for (const c of captions(SCENES[id], timings[id])) srt += `${++n}\n${srtTime(off + c.from)} --> ${srtTime(off + c.to)}\n${c.text}\n\n`;
    off += timings[id].dur;
  }
  fs.writeFileSync(path.join(OUT, 'promptlog-demo.srt'), srt);
  const total = ORDER.reduce((s, id) => s + timings[id].dur, 0);
  console.log(`wrote ${out} (${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')})`);
  for (const id of ORDER) console.log(`  ${id.padEnd(14)} ${timings[id].dur.toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
