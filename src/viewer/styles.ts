// Inline stylesheet for every viewer page. Pure string; no build step.
export const CSS = String.raw`
:root {
  --bg: #f6f5f1; --surface: #ffffff; --surface-2: #f1f0eb; --code-bg: #f3f2ee;
  --text: #1b1b1f; --text-2: #34343b; --muted: #676770; --faint: #9c9ca4;
  --border: #e3e2dc; --border-strong: #cfcdc5;
  --accent: #3553d1; --accent-fg: #ffffff; --ai: #c2613f;
  --add: #1a7f37; --add-bg: #e7f7eb; --add-ln: #d2f0da;
  --del: #c4232f; --del-bg: #fdecec; --del-ln: #f9d7d7;
  --hunk-bg: #eef1fb; --hunk-fg: #5a6690;
  --warn: #9a5b00; --warn-bg: #fff7e6; --warn-border: #f0cf8a;
  --ok: #1a7f37; --ok-bg: #e7f7eb; --bad: #c4232f; --bad-bg: #fdecec; --mid: #9a5b00; --mid-bg: #fff3d6;
  --shadow: 0 1px 2px rgba(20, 20, 30, .04), 0 2px 10px rgba(20, 20, 30, .04);
  --s0: #3b5bdb; --s1: #9c36b5; --s2: #0b7f8f; --s3: #d9480f; --s4: #2b8a3e; --s5: #c2255c;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111114; --surface: #19191d; --surface-2: #212126; --code-bg: #1e1e23;
    --text: #ececef; --text-2: #d2d2d8; --muted: #9d9da7; --faint: #6d6d77;
    --border: #2b2b31; --border-strong: #3b3b43;
    --accent: #7c95ff; --accent-fg: #0d0f1a; --ai: #e58c6b;
    --add: #56d364; --add-bg: rgba(46, 160, 67, .15); --add-ln: rgba(46, 160, 67, .25);
    --del: #f47067; --del-bg: rgba(229, 83, 75, .15); --del-ln: rgba(229, 83, 75, .25);
    --hunk-bg: rgba(124, 149, 255, .1); --hunk-fg: #9aa7d8;
    --warn: #e3b341; --warn-bg: rgba(187, 128, 9, .12); --warn-border: rgba(187, 128, 9, .45);
    --ok: #56d364; --ok-bg: rgba(46, 160, 67, .16); --bad: #f47067; --bad-bg: rgba(229, 83, 75, .16); --mid: #e3b341; --mid-bg: rgba(187, 128, 9, .18);
    --shadow: 0 1px 2px rgba(0, 0, 0, .3);
    --s0: #7c95ff; --s1: #d57ff0; --s2: #3fc5d6; --s3: #ff8f5a; --s4: #69d17c; --s5: #f06595;
  }
}
.c0 { --c: var(--s0); } .c1 { --c: var(--s1); } .c2 { --c: var(--s2); } .c3 { --c: var(--s3); } .c4 { --c: var(--s4); } .c5 { --c: var(--s5); }

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 var(--sans); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, kbd { font-family: var(--mono); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.right { margin-left: auto; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip { position: absolute; left: -999px; top: 8px; background: var(--surface); padding: 6px 10px; border-radius: 6px; z-index: 10; }
.skip:focus { left: 8px; }
.dot { color: var(--faint); margin: 0 .35em; }
[hidden] { display: none !important; }

/* Top bar */
.topbar { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--border); }
.topbar-inner { max-width: 1000px; margin: 0 auto; padding: 0 20px; height: 48px; display: flex; align-items: center; gap: 14px; }
.brand { font-weight: 700; color: var(--text); letter-spacing: -.01em; display: flex; align-items: center; gap: 2px; }
.brand:hover { text-decoration: none; }
.brand-mark { color: var(--ai); }
.crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumbs code { font-size: 12.5px; color: var(--text-2); }
.crumbs .sep { color: var(--faint); }
.topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); cursor: pointer; white-space: nowrap; }
.toggle input { accent-color: var(--accent); margin: 0; }

.wrap { max-width: 900px; margin: 0 auto; padding: 0 20px 96px; }

/* Hero */
.hero { padding: 34px 0 18px; }
.eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.eyebrow code { text-transform: none; letter-spacing: 0; font-size: 12.5px; }
.range { display: inline-flex; gap: 6px; align-items: center; text-transform: none; letter-spacing: 0; font-weight: 500; }
.range code { background: var(--surface-2); border: 1px solid var(--border); padding: 1px 7px; border-radius: 6px; color: var(--text-2); }
h1 { font-size: 30px; line-height: 1.2; letter-spacing: -.022em; margin: 8px 0 6px; overflow-wrap: anywhere; }
.lede { color: var(--muted); margin: 0 0 20px; font-size: 15px; }
.lede strong { color: var(--text); font-weight: 600; }
.facts { display: flex; flex-wrap: wrap; align-items: center; }

.flow { display: grid; grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr); gap: 10px; align-items: stretch; }
.flow-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.flow-k { font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 2px 0; }
.flow-k .muted { text-transform: none; letter-spacing: 0; font-weight: 400; font-family: var(--mono); font-size: 11.5px; }
.flow-arrow { display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 22px; padding-top: 18px; }
.scard { display: flex; gap: 10px; align-items: flex-start; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; color: inherit; box-shadow: var(--shadow); }
.scard:hover { text-decoration: none; border-color: var(--c); }
.scard-body { display: flex; flex-direction: column; min-width: 0; }
.scard-title { font-weight: 600; color: var(--text); }
.scard-meta { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.sl { flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: var(--c); color: #fff; font-weight: 700; font-size: 12.5px; }
@media (prefers-color-scheme: dark) { .sl { color: #111; } }
.commits { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
.commits li { display: flex; align-items: baseline; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--border); min-width: 0; }
.commits li:first-child { border-top: 0; }
.sha { font-size: 12px; color: var(--muted); flex: none; }
.csub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.tref { flex: none; font: 600 11.5px/1 var(--mono); padding: 4px 6px; border-radius: 6px; color: var(--c, var(--accent)); background: color-mix(in srgb, var(--c, var(--accent)) 12%, transparent); white-space: nowrap; }
.tref:hover { text-decoration: none; background: color-mix(in srgb, var(--c, var(--accent)) 22%, transparent); }
span.tref.muted { color: var(--muted); background: var(--surface-2); font-weight: 500; }

/* Summary */
.summary { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 22px 20px; margin: 8px 0 26px; box-shadow: var(--shadow); }
.sum-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.sum-head h2, .index-sec h2 { font-size: 12px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 0; }
.sum-prov { font-size: 12px; }
.linkish { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
.linkish:hover { text-decoration: underline; }
.sum-intent { font-size: 18.5px; line-height: 1.45; font-weight: 500; letter-spacing: -.01em; }
.sum-approach { color: var(--text-2); margin-top: 8px; font-size: 14.5px; }
.sum-k { font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-right: 4px; }
.sum-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 28px; margin-top: 10px; }
.sum-card { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 8px; min-width: 0; }
.sum-card.wide { grid-column: 1 / -1; }
.sum-card h3 .pvd-tally { margin-left: auto; display: inline-flex; gap: 4px; }
.pvd-tally .pvd-st { min-width: 0; text-transform: none; letter-spacing: 0; font-weight: 600; }
.sum-more { margin-top: 8px; font-size: 14px; }
.sum-more > summary, .sum-fold > summary { cursor: pointer; color: var(--accent); font-size: 13px; font-weight: 600; width: fit-content; }
.sum-more > .sum-list { margin-top: 9px; }
.sum-folds { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border); margin-top: 14px; padding-top: 10px; }
.sum-fold > summary { color: var(--text-2); display: flex; align-items: center; gap: 6px; padding: 3px 0; }
.sum-fold > summary { list-style: none; }
.sum-fold > summary::-webkit-details-marker { display: none; }
.sum-fold > summary::before { content: "▸"; color: var(--faint); font-size: 11px; transition: transform .15s; }
.sum-fold[open] > summary::before { transform: rotate(90deg); }
.sum-fold[open] > summary { margin-bottom: 8px; }
.sum-fold .sum-list { margin-bottom: 8px; }
.sum-intent code, .sum-approach code, .sum-list code { font-size: .86em; background: var(--code-bg); border-radius: 4px; padding: 1px 4px; }
html.js .sum-approach .clamp { max-height: 4.9em; overflow: hidden; }
html.js .sum-approach .clamp.expanded { max-height: none; }
a.badge:hover { text-decoration: none; filter: brightness(.95); }
.sum-card h3 { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
.count { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: 0; color: var(--muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; line-height: 17px; }
.sum-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 9px; font-size: 14px; }
.sum-list li { display: flex; gap: 10px; align-items: baseline; }
.sum-list li > div { flex: 1; }
.sum-list li > div { min-width: 0; }
.sum-list.bullets li::before { content: "–"; color: var(--faint); }
.sum-list .tref { margin-left: 2px; }
.pushback { align-items: flex-start !important; }
.pb-human { font-style: italic; color: var(--text); }
.pb-ai { color: var(--text-2); margin-top: 2px; }
.pb-arrow { color: var(--faint); }
.sev, .pvd-st { flex: none; font: 700 10.5px/1 var(--sans); letter-spacing: .05em; text-transform: uppercase; padding: 4px 6px; border-radius: 5px; min-width: 58px; text-align: center; }
.sev-high, .pvd-missing { color: var(--bad); background: var(--bad-bg); }
.sev-medium, .pvd-partial { color: var(--mid); background: var(--mid-bg); }
.sev-low, .pvd-unclear { color: var(--muted); background: var(--surface-2); }
.pvd-done { color: var(--ok); background: var(--ok-bg); }
.loop-ico { color: var(--mid); font-weight: 700; }
.alts { margin-top: 3px; color: var(--muted); }
.alt { text-decoration: line-through; text-decoration-color: var(--faint); }
.mock-banner { font-size: 13px; color: var(--warn); background: var(--warn-bg); border: 1px dashed var(--warn-border); border-radius: 8px; padding: 6px 10px; margin: -4px 0 14px; }
.sum-empty { display: flex; gap: 14px; align-items: flex-start; border: 1px dashed var(--border-strong); border-radius: 10px; padding: 14px 16px; margin-top: 6px; color: var(--text-2); font-size: 14px; }
.sum-empty p { margin: 4px 0 0; }
.sum-empty-ico { flex: none; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: var(--surface-2); color: var(--muted); font-weight: 700; }
.sum-err .sum-empty-ico { color: var(--bad); background: var(--bad-bg); }
.sum-loading { display: flex; gap: 14px; align-items: center; margin: 6px 0 12px; font-size: 14px; }
.spinner { flex: none; width: 22px; height: 22px; border-radius: 50%; border: 2.5px solid var(--border); border-top-color: var(--ai); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.skeleton { display: flex; flex-direction: column; gap: 9px; }
.skeleton span { display: block; height: 11px; border-radius: 6px; background: linear-gradient(90deg, var(--surface-2), var(--border), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite; }
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .spinner, .skeleton span { animation: none; } }

/* Tabs */
.tabs { position: sticky; top: 48px; z-index: 4; display: flex; gap: 4px; background: var(--bg); border-bottom: 1px solid var(--border); margin: 0 -4px; padding: 0 4px; }
.tab { display: flex; align-items: center; gap: 8px; padding: 11px 12px 10px; color: var(--muted); font-weight: 600; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tab:hover { text-decoration: none; color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab .count .num { font-family: var(--mono); }
.tabpanel { padding-top: 4px; }
.diff-intro { margin: 14px 0 4px; }

/* Slices */
.slice-head { display: flex; gap: 12px; align-items: center; margin: 30px 0 4px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.slice-head .sl { width: 30px; height: 30px; font-size: 14px; border-radius: 9px; }
.slice-title { font-weight: 700; font-size: 17px; letter-spacing: -.01em; }
.slice-meta { font-size: 12.5px; color: var(--muted); }
.slice-meta code { font-size: 12px; }
.slice-note { font-size: 13px; color: var(--muted); border: 1px dashed var(--border-strong); border-radius: 10px; padding: 8px 12px; margin: 14px 0; }

/* Turns */
.turn { margin: 22px 0 34px; scroll-margin-top: 110px; border-radius: 14px; }
.turn:target { outline: 2px solid color-mix(in srgb, var(--c) 55%, transparent); outline-offset: 8px; }
.turn-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.tlabel { font: 700 12px/1 var(--mono); color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); padding: 5px 7px; border-radius: 6px; }
.tlabel:hover { text-decoration: none; background: color-mix(in srgb, var(--c) 22%, transparent); }
.avatar { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; background: var(--text-2); color: var(--bg); font-size: 9.5px; font-weight: 700; letter-spacing: .02em; }
.who { color: var(--text); font-weight: 600; font-size: 13.5px; }
.annot { display: inline-flex; flex-wrap: wrap; gap: 5px; }
.annot:empty { display: none; }
.gist { margin: 6px 0 0; color: var(--muted); font-size: 13.5px; font-style: italic; }
.from-peer { margin-top: 10px; font-size: 13px; color: var(--muted); }
.prompt { margin-top: 10px; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--c); border-radius: 12px; padding: 14px 18px; font-size: 16.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; box-shadow: var(--shadow); color: var(--text); }
.prompt code { font-size: .86em; background: var(--code-bg); border-radius: 4px; padding: 1px 5px; }

.ai { margin: 14px 0 0 12px; padding-left: 18px; border-left: 2px solid var(--border); }
.ai-head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 4px; }
.ai-head .muted { font-weight: 400; }
.ai-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ai); margin-left: -24px; margin-right: 9px; box-shadow: 0 0 0 3px var(--bg); }
.reply { margin: 8px 0; color: var(--text-2); font-size: 14.5px; }
.reply:not(.final) { color: var(--muted); font-size: 14px; }
.clamp { position: relative; }
html.js .clamp { max-height: 6.5em; overflow: hidden; }
html.js .reply:not(.final) .clamp { max-height: 3.3em; }
html.js .clamp.expanded { max-height: none; }
.clamp.clamped:not(.expanded) { -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent); mask-image: linear-gradient(to bottom, #000 55%, transparent); }
.more { background: none; border: 0; padding: 2px 0; font: 600 12.5px var(--sans); color: var(--accent); cursor: pointer; }
.more:hover { text-decoration: underline; }

.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 .6em; }
.md ul, .md ol { margin: .2em 0 .6em; padding-left: 1.35em; }
.md li { margin: .15em 0; }
.md li > p { margin: 0; }
.md h3, .md h4, .md h5, .md h6 { font-size: 1em; margin: .8em 0 .3em; color: var(--text); }
.md code { font-size: .87em; background: var(--code-bg); border-radius: 4px; padding: 1px 5px; overflow-wrap: anywhere; }
.md pre.code { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow: auto; font-size: 12.5px; line-height: 1.5; }
.md pre.code code { background: none; padding: 0; font-size: inherit; }
.md blockquote { margin: .4em 0; padding-left: 12px; border-left: 3px solid var(--border-strong); color: var(--muted); }
.md strong { color: var(--text); font-weight: 600; }
.md hr { border: 0; border-top: 1px solid var(--border); margin: .8em 0; }
.table-wrap { overflow-x: auto; }
.md table { border-collapse: collapse; font-size: 13.5px; margin: .4em 0 .8em; }
.md th, .md td { border: 1px solid var(--border); padding: 4px 9px; text-align: left; }
.md th { background: var(--surface-2); }

/* Tool strip */
.tools { margin: 6px 0; }
.tools > summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; font: 12.5px/1.4 var(--mono); color: var(--muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; }
.tools > summary::-webkit-details-marker, .tool > summary::-webkit-details-marker, .thinking > summary::-webkit-details-marker, .event > summary::-webkit-details-marker, .diff-file > summary::-webkit-details-marker { display: none; }
.tools > summary:hover { border-color: var(--border-strong); color: var(--text-2); }
.tools[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.tools-ico { flex: none; font-weight: 700; color: var(--faint); }
.strip { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tools[open] .strip { white-space: normal; }
.tl b { font-weight: 600; color: var(--text-2); }
.tl-err b { color: var(--bad); }
.targ { color: var(--muted); }
.times { margin-left: 3px; color: var(--faint); }
.tools-n { flex: none; font: 11.5px var(--sans); color: var(--faint); }
.tools-n::after { content: "▸"; margin-left: 6px; display: inline-block; transition: transform .15s; }
.tools[open] > summary .tools-n::after { transform: rotate(90deg); }
.tool-list { list-style: none; margin: 0; padding: 4px; border: 1px solid var(--border); border-top: 0; border-radius: 0 0 8px 8px; background: var(--surface); }
.tool > summary { list-style: none; cursor: pointer; font: 12.5px/1.4 var(--mono); padding: 5px 8px; border-radius: 6px; display: flex; gap: 6px; align-items: baseline; }
.tool > summary::before { content: "▸"; color: var(--faint); font-size: 11px; transition: transform .15s; }
.tool[open] > summary::before { transform: rotate(90deg); }
.tool > summary:hover { background: var(--surface-2); }
.tname { font-weight: 600; color: var(--text-2); }
.tool .targ { overflow-wrap: anywhere; }
.tool-body { padding: 2px 8px 10px 22px; }
.tool-sec { font: 700 10.5px/1 var(--sans); letter-spacing: .07em; text-transform: uppercase; color: var(--faint); margin: 10px 0 5px; }
.tool-path code, .tool-caption { font-size: 12px; color: var(--muted); }
.tool-body pre, .event pre, .raw-entry pre { margin: 0; font-size: 12px; line-height: 1.5; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-body pre.err { border-color: var(--bad); color: var(--bad); }
.tool-body pre.cmd { color: var(--text); }
.clip-note { font-size: 12px; color: var(--faint); margin-top: 4px; }
.mini-diff { font: 12px/1.5 var(--mono); border: 1px solid var(--border); border-radius: 6px; max-height: 360px; overflow: auto; margin-top: 4px; }
.mini-diff div { white-space: pre-wrap; overflow-wrap: anywhere; padding: 0 8px; }
.mini-diff .add { background: var(--add-bg); }
.mini-diff .del { background: var(--del-bg); }
.todos { list-style: none; padding: 0; margin: 0; font-size: 13px; }
.todo-completed { color: var(--muted); text-decoration: line-through; }

.thinking { display: none; margin: 6px 0; border: 1px dashed var(--border-strong); border-radius: 8px; padding: 6px 10px; font-size: 13.5px; color: var(--muted); }
body:has(#show-thinking:checked) .thinking { display: block; }
.thinking > summary { cursor: pointer; list-style: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-style: italic; }
.thinking[open] > summary { margin-bottom: 6px; }
.think-ico { color: var(--ai); font-style: normal; }
.event { margin: 6px 0; font-size: 12.5px; color: var(--muted); }
.event > summary { cursor: pointer; list-style: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
div.event, .event > summary { font-weight: 600; }
.ev-interrupt { color: var(--warn); }

/* Turn footer */
.turn-foot { margin: 10px 0 0 32px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.chip { display: inline-flex; align-items: center; gap: 6px; font: 12px/1.3 var(--mono); background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; max-width: 100%; min-width: 0; }
.chip .fname, .chip .csub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.commit .csub { font-family: var(--sans); color: var(--text-2); }
.chip.commit code { color: var(--text); font-weight: 600; }
.commit-ico { color: var(--c, var(--accent)); font-size: 9px; }
.chip.none { color: var(--faint); font-family: var(--sans); border-style: dashed; }
.st { flex: none; display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; font: 700 10px/1 var(--mono); color: #fff; }
.st-A { background: var(--add); } .st-M { background: #b7791f; } .st-D { background: var(--del); } .st-R, .st-C { background: #7048e8; } .st-T { background: var(--muted); }
@media (prefers-color-scheme: dark) { .st { color: #111; } .st-M { background: #e3b341; } .st-R, .st-C { background: #b197fc; } }
.num { white-space: nowrap; font-family: var(--mono); font-size: .92em; }
.plus { color: var(--add); }
.minus { color: var(--del); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.act { display: inline-flex; align-items: center; gap: 6px; font: 500 12.5px/1 var(--sans); color: var(--text-2); background: transparent; border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; cursor: pointer; }
.act:hover { background: var(--surface-2); border-color: var(--border-strong); text-decoration: none; }
.act[aria-expanded="true"] { background: var(--surface-2); border-color: var(--border-strong); color: var(--text); }
.act span[aria-hidden] { font-family: var(--mono); color: var(--muted); }
.act.primary { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.act.primary code { font-size: 12px; }
.panel { margin: 8px 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow: hidden; }
.panel .diff-file { margin: 0; border: 0; border-radius: 0; border-top: 1px solid var(--border); }
.panel .diff-summary { padding: 8px 12px; margin: 0; }
.panel-loading, .panel-error { padding: 10px 12px; font-size: 13px; color: var(--muted); }
.panel-error { color: var(--bad); }

/* Ask */
.asks:empty { display: none; }
.ask-item { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--ai); border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
.ask-q { font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.ask-q-ico, .ask-ico { flex: none; display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: color-mix(in srgb, var(--ai) 16%, transparent); color: var(--ai); font: 700 11px/1 var(--sans); }
.ask-a { margin-top: 6px; font-size: 14.5px; color: var(--text-2); }
.ask-meta { margin-top: 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.ask-meta code { font-size: 11.5px; }
form.ask { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 4px 4px 4px 10px; transition: border-color .15s, box-shadow .15s; }
form.ask:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
form.ask input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: 14px var(--sans); padding: 6px 0; outline: none; }
form.ask input::placeholder { color: var(--faint); }
form.ask button { flex: none; font: 600 13px var(--sans); color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 7px; padding: 7px 14px; cursor: pointer; }
form.ask button:disabled { opacity: .5; cursor: progress; }
.ask-status { flex-basis: 100%; font-size: 12.5px; color: var(--muted); padding: 0 0 4px; }
.ask-status:empty { display: none; }
.ask-status.err { color: var(--bad); }
.ask-off { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: var(--text-2); border: 1px dashed var(--border); border-radius: 10px; padding: 7px 10px; }
.ask-off .ask-ico { background: var(--surface-2); color: var(--faint); }

/* Human edits between turns */
.human-edit { margin: 22px 0 0; border: 1px dashed var(--warn-border); background: var(--warn-bg); border-radius: 12px; padding: 9px 12px; font-size: 13.5px; }
.he-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.he-row .act { margin-left: auto; }
.he-ico { color: var(--warn); font-weight: 700; }
.human-edit strong { color: var(--warn); }

/* Badges */
.badge { display: inline-flex; align-items: center; font: 700 10.5px/1 var(--sans); letter-spacing: .04em; text-transform: uppercase; padding: 4px 7px; border-radius: 999px; white-space: nowrap; }
.b-push { color: var(--mid); background: var(--mid-bg); }
.b-risk-high { color: var(--bad); background: var(--bad-bg); }
.b-risk-medium { color: var(--mid); background: var(--mid-bg); }
.b-risk-low, .b-muted { color: var(--muted); background: var(--surface-2); }
.b-loop { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.b-dec { color: var(--text-2); background: var(--surface-2); }
.b-pvd, .b-err { color: var(--bad); background: var(--bad-bg); }

/* Code diff */
.diff-summary { font-size: 13px; color: var(--muted); margin: 10px 0; }
.diff-file { border: 1px solid var(--border); border-radius: 10px; margin: 12px 0; overflow: hidden; background: var(--surface); }
.diff-file > summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; padding: 8px 12px; background: var(--surface-2); font: 12.5px/1.4 var(--mono); position: relative; }
.diff-file > summary::before { content: "▸"; color: var(--faint); font-size: 11px; transition: transform .15s; }
.diff-file[open] > summary::before { transform: rotate(90deg); }
.diff-file[open] > summary { border-bottom: 1px solid var(--border); }
.diff-file .path { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.diff-file .arrow { color: var(--faint); }
.diff-table { width: 100%; border-collapse: collapse; font: 12px/1.55 var(--mono); }
.diff-table td { padding: 0; vertical-align: top; }
.diff-table td.ln { width: 1%; min-width: 38px; padding: 0 8px; text-align: right; color: var(--faint); user-select: none; -webkit-user-select: none; }
.diff-table td.ln::before { content: attr(data-n); }
.diff-table td.code { white-space: pre-wrap; overflow-wrap: anywhere; padding: 0 12px 0 6px; }
.diff-table tr.add td { background: var(--add-bg); }
.diff-table tr.add td.ln { background: var(--add-ln); color: var(--add); }
.diff-table tr.del td { background: var(--del-bg); }
.diff-table tr.del td.ln { background: var(--del-ln); color: var(--del); }
.diff-table tr.hunk td { background: var(--hunk-bg); color: var(--hunk-fg); padding-top: 4px; padding-bottom: 4px; }
.diff-table tr.meta td { color: var(--faint); font-style: italic; }
.diff-note, .empty-note { padding: 12px; font-size: 13.5px; color: var(--muted); }
.empty-note { border: 1px dashed var(--border-strong); border-radius: 10px; margin: 12px 0; }
.warn-text { color: var(--warn); }

/* Raw log */
.raw-log { padding: 8px 10px 10px; max-height: 70vh; overflow: auto; }
.raw-bar { margin-bottom: 8px; }
.raw-entry { margin-bottom: 8px; }
.raw-head { font: 600 11.5px/1.4 var(--mono); color: var(--muted); margin-bottom: 3px; }
.raw-entry pre { max-height: 280px; }

/* Index */
.index-sec { margin: 18px 0 32px; }
.index-sec h2 { margin-bottom: 12px; }
.branch-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.branch-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); }
.branch-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.branch-name { font-weight: 700; font-size: 15px; }
.branch-name code { font-size: 14.5px; }
.branch-sessions { margin: 8px 0 12px; padding-left: 18px; font-size: 14px; color: var(--muted); }
.sessions { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; font-size: 14px; }
.sessions th { text-align: left; font-size: 11.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); padding: 8px 12px; }
.sessions td { padding: 9px 12px; border-top: 1px solid var(--border); vertical-align: baseline; }
.sessions code { font-size: 12.5px; }
.num-col { text-align: right; font-variant-numeric: tabular-nums; }

.error-page { padding: 60px 0; }
.error-detail { white-space: pre-wrap; font-size: 12.5px; background: var(--code-bg); border-radius: 8px; padding: 10px 12px; overflow: auto; }
.copyable { user-select: all; }

@media (max-width: 720px) {
  .flow { grid-template-columns: minmax(0, 1fr); }
  .flow-arrow { transform: rotate(90deg); padding: 0; height: 22px; }
  .sum-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  body { font-size: 14.5px; }
  .topbar-inner, .wrap { padding-left: 14px; padding-right: 14px; }
  .toggle > span > .muted { display: none; }
  .hero { padding-top: 22px; }
  h1 { font-size: 24px; }
  .summary { padding: 14px 14px 16px; border-radius: 12px; }
  .sum-intent { font-size: 16.5px; }
  .prompt { font-size: 15.5px; padding: 12px 14px; }
  .ai { margin-left: 4px; padding-left: 14px; }
  .ai-dot { margin-left: -20px; margin-right: 7px; }
  .turn-foot { margin-left: 0; }
  .tab { padding: 10px 8px; font-size: 13.5px; }
  .tab .count { display: none; }
  .sessions th:nth-child(5), .sessions td:nth-child(5), .sessions th:nth-child(6), .sessions td:nth-child(6) { display: none; }
  .diff-table td.ln { min-width: 28px; padding: 0 4px; }
  .he-row .act { margin-left: 0; }
}

/* At a glance: one "asked / did" pair per turn */
.glance, .files-why, .qask-sec { margin: 8px 0 22px; }
.glance { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px 20px 14px; box-shadow: var(--shadow); }
.glance-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.glance-head h2 { font-size: 12px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 0; }
.glance-prov { font-size: 12px; text-align: right; }
.glance-headline { font-size: 18.5px; line-height: 1.4; font-weight: 600; letter-spacing: -.01em; margin: 2px 0 12px; }
.glance-headline code, .gt-text code, .fw-why code { font-size: .86em; background: var(--code-bg); border-radius: 4px; padding: 1px 4px; }
.glance-turns { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; }
.gt { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--border); }
.gt:first-child { border-top: 0; padding-top: 4px; }
.gt .tlabel { flex: none; margin-top: 1px; }
.gt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.gt-line { display: flex; gap: 8px; align-items: baseline; font-size: 14.5px; }
.gt-who { flex: none; width: 58px; font-size: 12px; font-weight: 700; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-who.gt-ai { color: var(--ai); }
.gt-text { min-width: 0; overflow-wrap: anywhere; }
.gt-line:first-child .gt-text { font-weight: 500; }
.gt-meta { margin-left: 66px; font-size: 12px; color: var(--muted); }
.gt-meta code { font-size: 11.5px; }
.gt-fold { padding: 8px 0 2px; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; color: var(--muted); }
.gt-fold-k { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); margin-right: 2px; }
.gt-fold .dot { margin: 0 .15em; }

/* Beyond what was asked: the reviewer's first stop */
.beyond { margin-top: 12px; border: 1px solid var(--warn-border); background: var(--warn-bg); border-radius: 10px; padding: 10px 14px 12px; }
.beyond h3 { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--warn); margin: 0 0 6px; display: flex; align-items: center; gap: 6px; }
.beyond h3 .count { font: 700 11px/1 var(--sans); background: color-mix(in srgb, var(--warn) 18%, transparent); padding: 3px 6px; border-radius: 999px; letter-spacing: 0; }
.beyond ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 9px; }
.bw-change { font-size: 14.5px; font-weight: 500; }
.bw-change code { font-size: .86em; background: var(--code-bg); border-radius: 4px; padding: 1px 4px; }
.bw-where { display: inline-flex; gap: 4px; flex-wrap: wrap; margin-left: 4px; }
.bw-where code { font-size: 12px; }
.bw-reason { font-size: 13px; color: var(--text-2); margin-top: 2px; }
.bw-reason.none { color: var(--warn); font-weight: 600; }
.everywhere { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px 12px; }
.everywhere h3 { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-2); margin: 0 0 6px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.everywhere .ev-prov { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--muted); }
.everywhere > ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 9px; }
.ev-name { font-size: 14px; }
.ev-name > code { font-weight: 600; }
.ev-name code, .ev-hits code { font-size: 12px; background: var(--code-bg); border-radius: 4px; padding: 1px 4px; }
.ev-status { font-size: 13px; font-weight: 600; margin-top: 2px; }
.ev-left .ev-status { color: var(--warn); }
.ev-gone .ev-status { color: var(--ok); }
.ev-hits { list-style: none; padding: 0; margin: 3px 0 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.ev-hits li { display: flex; gap: 6px; min-width: 0; }
.ev-hits .ev-text { background: none; padding: 0; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ev-hits .more { color: var(--muted); }
.ev-hits .ev-wrote { opacity: .7; }
.ev-tag { flex: none; font-size: 11px; color: var(--muted); }

/* Files changed: why, and where */
.files-why .glance-head { padding: 0 2px; }
.fw-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.fw { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.fw > summary { list-style: none; cursor: pointer; padding: 10px 14px; display: flex; flex-direction: column; gap: 4px; }
.fw > summary::-webkit-details-marker { display: none; }
.fw > summary:hover { background: color-mix(in srgb, var(--surface-2) 60%, transparent); }
.fw-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.fw-path { font-size: 13.5px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.fw-by { display: inline-flex; gap: 4px; }
.fw-open { margin-left: auto; font-size: 12px; color: var(--accent); }
.fw-open::after { content: " ▸"; }
.fw[open] .fw-open::after { content: " ▾"; }
.fw-why { font-size: 14px; color: var(--text-2); }
.fw-spots { list-style: none; padding: 0; margin: 2px 0 0; display: flex; flex-direction: column; gap: 2px; }
.fw-spots li { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; min-width: 0; }
.fw-spots .ln { flex: none; min-width: 44px; font: 600 11.5px/1.6 var(--mono); color: var(--muted); text-align: right; }
.fw-spots li.add .ln { color: var(--add); }
.fw-spots li.del .ln { color: var(--del); }
.fw-spots code { font-size: 12px; background: var(--code-bg); border-radius: 4px; padding: 1px 6px; white-space: pre; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.fw-spots li.del code { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--del) 55%, transparent); color: var(--muted); }
.fw-spots li.more { padding-left: 52px; color: var(--muted); font-size: 12px; }
.fw-diff { border-top: 1px solid var(--border); }
.fw-diff .diff-file { border: 0; border-radius: 0; margin: 0; }

/* Quick ask about the whole page */
form.qask { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface); padding: 5px 5px 5px 12px; box-shadow: var(--shadow); transition: border-color .15s, box-shadow .15s; }
form.qask:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
form.qask input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: 15px var(--sans); padding: 8px 0; outline: none; }
form.qask input::placeholder { color: var(--faint); }
form.qask button { flex: none; font: 600 13.5px var(--sans); color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer; }
form.qask button:disabled { opacity: .5; cursor: progress; }
.qask-off { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); border: 1px dashed var(--border-strong); border-radius: 12px; padding: 9px 12px; }
.qask-off .ask-ico { background: var(--surface-2); color: var(--faint); }
.qask-note { margin: 6px 4px 0; }
.qask-sec .ask-status { padding: 6px 4px 0; }
.qasks:empty { display: none; }
.qa-verdict { margin-top: 6px; font-size: 13.5px; }
.qa-verdict strong { display: inline-block; font-size: 12px; letter-spacing: .03em; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.qa-verdict.v-yes strong { background: var(--ok-bg); color: var(--ok); }
.qa-verdict.v-no strong { background: var(--bad-bg); color: var(--bad); }
.qa-verdict.v-partly strong, .qa-verdict.v-unclear strong { background: var(--mid-bg); color: var(--mid); }
.qa-search { margin-top: 6px; color: var(--text-2); }
.qa-search code { font-size: 11.5px; background: var(--code-bg); border-radius: 4px; padding: 1px 4px; }

/* The full record, collapsed under the glance */
.full { margin: 26px 0 0; }
.full > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.full > summary::-webkit-details-marker { display: none; }
.full > summary::before { content: "▸"; color: var(--faint); font-size: 12px; transition: transform .15s; }
.full[open] > summary::before { transform: rotate(90deg); }
.full[open] > summary { margin-bottom: 14px; }
.full-title { font-weight: 600; }

/* Deep review waits for a click */
.sum-idle { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 14px; }
.sum-idle .act { flex: none; }

@media (max-width: 640px) {
  .glance { padding: 14px 14px 10px; }
  .gt { gap: 8px; }
  .gt-who { width: 46px; }
  .gt-meta { margin-left: 54px; }
  .fw > summary { padding: 10px 12px; }
  .fw-spots .ln { min-width: 36px; }
  .sum-idle { flex-direction: column; align-items: flex-start; }
}

/* ---- PR page (pr.ts): turns with the code each one wrote ---- */
.pr { padding-top: 24px; }
.pr-head h1 { font-size: 28px; line-height: 1.2; margin: 6px 0 8px; overflow-wrap: anywhere; }
.pr-range { font-size: 13px; color: var(--muted); }
.pr-range code { background: var(--surface-2); padding: 1px 6px; border-radius: 6px; }
.pr-meta { margin: 0; color: var(--text-2); font-size: 14.5px; }
.pr-cover { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.pr-tabs { display: flex; gap: 18px; margin: 18px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 8px; font-size: 14px; position: sticky; top: 0; background: var(--bg); z-index: 2; }
.pr-tabs a { color: var(--text); text-decoration: none; font-weight: 600; }
.pr-tabs a.muted { margin-left: auto; font-weight: 400; color: var(--muted); }
.pr-session { --c: var(--s0); }
.pr-session-title { font-size: 15px; margin: 22px 0 6px; }
.pr-session-title .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--c); margin: 0 8px 0 0; }
.pr-turn { margin: 14px 0; border: 1px solid var(--border); border-left: 3px solid var(--c); border-radius: 12px; background: var(--surface); padding: 12px 14px; box-shadow: var(--shadow); scroll-margin-top: 48px; }
.pr-turn.from-agent { border-left-color: var(--accent); }
.pr-turn-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; }
.pr-turn-head .grow { flex: 1; }
.pr-who { font-weight: 650; }
.pr-who.agent { color: var(--accent); }
.pr-tag { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0 6px; }
.pr-n { color: var(--muted); text-decoration: none; font-family: var(--mono); font-size: 12px; }
.pr-at { color: var(--muted); font-size: 12px; }
.pr-turn-stat { font-size: 12.5px; color: var(--text-2); }
.pr-ask { margin: 10px 0 0; font-size: 15.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.pr-ask.long > summary { list-style: none; cursor: pointer; }
.pr-ask.long > summary::-webkit-details-marker { display: none; }
.pr-ask.long[open] .pr-ask-head, .pr-ask.long[open] .pr-more { display: none; }
.pr-more { display: inline-block; margin-left: 6px; color: var(--accent); font-size: 13px; }
.pr-did { margin: 10px 0 0; font-size: 14.5px; line-height: 1.5; color: var(--text-2); overflow-wrap: anywhere; }
.pr-did q { quotes: "“" "”"; }
.pr-did-label { font-weight: 650; color: var(--ai, var(--text)); margin-right: 8px; }
.pr-src { font-size: 11px; color: var(--muted); border: 1px dashed var(--border-strong); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
.pr-files { margin-top: 10px; display: grid; gap: 6px; }
.pr-file { border: 1px solid var(--border); border-radius: 8px; background: var(--bg); min-width: 0; }
.pr-file > summary { display: flex; gap: 8px; align-items: center; padding: 7px 10px; cursor: pointer; font-size: 13px; }
.pr-path { font-family: var(--mono); font-size: 12.5px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pr-code { overflow-x: auto; border-top: 1px solid var(--border); font: 12px/1.55 var(--mono); padding: 4px 0; }
.pl { display: grid; grid-template-columns: 40px 16px max-content; white-space: pre; }
.pl-no { color: var(--faint); text-align: right; padding-right: 6px; user-select: none; }
.pl-sign { color: var(--muted); user-select: none; }
.pl-add { background: var(--add-bg); }
.pl-add .pl-sign { color: var(--add); }
.pl-del { background: var(--del-bg); }
.pl-del .pl-sign { color: var(--del); }
.pl-ctx .pl-tx { color: var(--text-2); }
.pl-gap { color: var(--faint); padding: 0 0 0 56px; }
.pr-by { display: block; margin: 6px 0 2px 56px; font: 600 11.5px/1.4 var(--sans); color: var(--accent); text-decoration: none; }
.pr-by.none { color: var(--muted); font-weight: 500; }
.pr-raw { display: inline-block; margin-top: 10px; font-size: 12.5px; color: var(--muted); }
.pr-quiet { margin: 4px 0; border-left: 3px solid var(--border); padding: 2px 0 2px 12px; scroll-margin-top: 48px; }
.pr-quiet > summary { display: flex; gap: 8px; align-items: baseline; cursor: pointer; font-size: 13.5px; color: var(--text-2); min-width: 0; }
.pr-q-who { font-weight: 600; color: var(--text); flex: none; }
.pr-q-ask { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-q-ask.cmd { font-family: var(--mono); font-size: 12.5px; }
.pr-quiet-body { padding: 4px 0 8px; }
.pr-filesec h2 { font-size: 18px; margin: 28px 0 10px; }
.pr-filesec .pr-file { margin-bottom: 8px; }
.pr-commits { margin: 24px 0; font-size: 13.5px; color: var(--text-2); }
.pr-commits ul { padding-left: 18px; }
@media (max-width: 640px) {
  .pr-head h1 { font-size: 22px; }
  .pr-turn { padding: 10px 11px; border-radius: 10px; }
  .pr-ask { font-size: 15px; }
  .pl { grid-template-columns: 30px 14px max-content; }
  .pr-by, .pl-gap { margin-left: 44px; padding-left: 0; }
}
`;
