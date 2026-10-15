// The demo's script: narration (one entry per sentence) and what happens on screen.
// A sentence is a string, or { say, cap } when the spoken text differs from the caption; { pause } adds a beat after it.
// Timelines get t = { c(i, d), e(i, d), cues, ends, dur }: c = start of sentence i (+d s), e = its end.
// Timeline steps: scroll (selector | number | {by}), click (selector, cursor glides there first),
// hl (highlight box, optional label), cursor ('hide'). See build.mjs for the engine.
//
// The spine of the cut: the prompt is the unit of work now; code is what it compiles to; promptlog keeps the
// source next to the code and lets you review it. Every scene shows one piece of that.

// The tagline, in one place (spoken form, caption form, and the HTML with the emphasis).
export const TAGLINE = 'Review the conversation that built the code, not just the diff.';
export const TAGLINE_HTML = 'Review the <em>conversation</em> that built the code, not just the diff.';

export const CONFIG = {
  // Voice: a macOS `say` voice name, or 'gemini:<voice>' (Kore, Charon, Puck, ...) for Gemini TTS over HTTPS.
  // Gemini needs the key `gemini` in ~/.config/promptlog/config.json and costs money: switch only with an explicit go.
  voice: 'gemini:Charon',
  rate: 180, // `say` only
  style: '', // Gemini only
  ttsModel: 'gemini-3.8-flash-tts',
  // Background music: null for none. Apple Loops ship with GarageBand/Logic and are royalty-free in your own work.
  music: { file: '/Library/Audio/Apple Loops/Apple/07 Chillwave/Delicate Lines Synth.caf', db: -33 },
  minTotal: 0, // no padding: the extra minutes must be real content
  repoUrl: 'github.com/jkrup/promptlog',
  demoUrl: 'promptlog-viewer.mazlix-f8e.workers.dev/review?base=main&head=feature%2Frates&repo=promptlog-demo',
  homeUrl: 'promptlog-home.mazlix-f8e.workers.dev',
};

// Order of the final cut. Each id is its own segment (build/seg-<id>.mp4 + .wav), so scenes can be
// re-rendered or re-ordered without touching the rest.
export const ORDER = ['setup', 'overview', 'hook-pr', 'review-t13', 'turns', 'review-t14', 'agents', 'review-t7', 'review-files', 'leases', 'leases-web', 'arch', 'close'];
// The short cut (out/promptlog-demo-short.mp4): the first 90 seconds tell the whole story, then the close card.
export const SHORT = ['setup', 'overview', 'hook-pr', 'close'];

const VIEWER = 'http://[::1]:4812/review?base=main&head=clef-visibility-and-safety';
const LIVE = '<b>Live</b> &middot; the real pull request, in promptlog';
const T = (id) => `#t-a76c927d-${id}`;
const scene = (f) => `file://${new URL(`./scenes/${f}`, import.meta.url).pathname}`;

/** Marks the overview cards the live scenes point at (found by their text, the page is a fixed clone). */
async function markOverview(page) {
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ov-chg')];
    const first = cards[0];
    first.id = '__ov1';
    first.querySelector('.ov-model').id = '__ov1what';
    first.querySelector('blockquote.ov-q').id = '__ov1q';
    const safe = cards.find((c) => c.textContent.includes('"IPv4 address" field for input'));
    safe.id = '__ovsafe';
    safe.querySelector('.ov-model').id = '__ovwhat';
    safe.querySelector('blockquote.ov-q').id = '__ovq';
    safe.querySelector('.ov-res').closest('blockquote').id = '__ovtried';
    const stop = cards.find((c) => c.textContent.includes('we need a stop buddton'));
    stop.id = '__ovstop';
    [...stop.querySelectorAll('blockquote.ov-q')].find((q) => q.textContent.includes('stop buddton')).id = '__ovstopq';
  });
}

export const SCENES = {
  // ---- a plain walkthrough: what it is, set it up, review a real branch, many agents, Cloudflare ----
  intro: {
    url: scene('title.html'),
    lead: 0.8,
    sentences: [
      "Most of our code is written by Claude Code now, so the real record of why a change was made is the conversation, not the diff.",
      { say: 'Prompt log saves those conversations next to the commits, and shows them in the pull request.', cap: 'promptlog saves those conversations next to the commits, and shows them in the pull request.' },
      "I'll set it up on a project I'm working on, then review a branch that Claude Code built.",
    ],
    tail: 0.8,
  },

  // ---- the hook: the payoff first, no title card ----
  'hook-pr': {
    url: VIEWER,
    badge: LIVE,
    lead: 1.0,
    setup: async (page) => {
      await markOverview(page);
      // A cold open: the page is zoomed so one card fills the frame, and each card we land on gets headroom
      // above it for the label (the previous card's tail ends up behind the sticky top bar).
      await page.evaluate(() => {
        document.querySelector('.pr').style.zoom = '1.4';
        for (const id of ['__ovsafe', '__ovstop']) document.getElementById(id).style.marginTop = '56px';
      });
    },
    start: { sel: '#__ovsafe', offset: -84 },
    sentences: [
      "With this change, the extension won't type into a field that doesn't fit. I didn't ask for it. Another Claude session, which was using the extension to set up DNS records, sent it in as a bug report.",
      { say: 'Later, that same session retested it, and reported that it worked.', cap: 'Later, that same session retested it, and reported that it worked.', pause: 0.6 },
      { say: 'And the Stop button came from a message I typed while Claude was in the middle of something else.', cap: 'And the Stop button came from a message I typed while Claude was in the middle of something else.' },
    ],
    timeline: (t) => [
      { at: t.c(0, 0.2), hl: '#__ovsafe', until: t.c(0, 2.4), label: 'another agent asked for this', pad: 4 },
      { at: t.c(0, 2.4), hl: '#__ovq', until: t.e(0, 0.4), pad: 6 },
      { at: t.c(1, 0), hl: '#__ovtried', until: t.e(1, 0.5), pad: 6 },
      { at: t.c(2, 0), scroll: '#__ovstop', offset: -84, dur: 1.6 },
      { at: t.c(2, 1.6), hl: '#__ovstop', until: t.c(2, 3.4), label: 'typed while Claude was busy', pad: 4 },
      { at: t.c(2, 3.4), hl: '#__ovstopq', until: t.e(2, 1.2), pad: 6 },
    ],
    tail: 1.3,
  },

  'hook-lease': {
    url: scene('leases.html'),
    lead: 0.5,
    setup: async (page, { lease }) => {
      await page.evaluate((reason) => {
        for (const sel of ['.head', '.agents', '#t3', '#t2']) document.querySelector(sel).remove();
        const t1 = document.getElementById('t1');
        for (const k of ['s', 'd', 'out', 'od']) delete t1.dataset[k];
        t1.style.top = '150px';
        t1.querySelector('pre').style.fontSize = '21px';
        t1.querySelector('pre').style.lineHeight = '1.55';
        t1.querySelector('pre').style.padding = '22px 26px';
        const [l1, l2, ...rest] = reason.split('\n');
        const pre = document.getElementById('deny');
        pre.innerHTML = '';
        const span = (id, text) => { const s = document.createElement('span'); s.id = id; s.textContent = text; return s; };
        // Display only: the worktree's absolute path becomes ".../rates-api"; every other word is the hook's.
        pre.append(span('__l1', l1), '\n', span('__l2', l2.replace(/\/Users\/\S*\/rates-api/g, '…/rates-api')), '\n' + rest.join('\n'));
      }, lease.reason);
    },
    sentences: ['And this agent was just stopped from editing a function another agent is working on. Both keep working. Nothing gets clobbered.'],
    timeline: (t) => [
      { at: t.c(0, 0.2), hl: '#__l1', until: t.c(0, 3.4), pad: 5 },
      { at: t.c(0, 3.4), hl: '#__l2', until: t.e(0, 0.8), pad: 5 },
    ],
    tail: 1.2,
  },

  // ---- the idea, in four lines ----
  thesis: {
    url: scene('thesis.html'),
    setup: async (page) => {
      await page.evaluate((html) => { document.getElementById('tag').innerHTML = html; }, TAGLINE_HTML);
    },
    sentences: [
      'Agents write most of the code now. The prompt is the unit of work. Code is what it compiles to.',
      'But review still reads the compiled output: a diff, line by line. The source gets thrown away.',
      { say: 'Prompt log keeps the source in git, next to the code, and lets you review it. Messages between agents, too.', cap: 'promptlog keeps the source in git, next to the code, and lets you review it. Messages between agents, too.' },
      { say: `Prompt log. ${TAGLINE}`, cap: `promptlog. ${TAGLINE}` },
    ],
    tail: 1.4,
  },

  setup: {
    url: scene('setup.html'),
    sentences: [
      { say: "This is browser use, a Chrome extension I'm building with Claude Code. In its folder, I run prompt log connect.", cap: "This is browser-use, a Chrome extension I'm building with Claude Code. In its folder, I run promptlog connect." },
      'That adds hooks that record each Claude Code turn, and creates a private git repo for the project on Cloudflare Artifacts.',
      { say: "It also imports the sessions I'd already had in this folder, twenty-two turns, and links them to the six commits they made.", cap: "It also imports the sessions I'd already had in this folder, 22 turns, and links them to the 6 commits they made." },
      { say: "From then on, whenever Claude or I commit, prompt log pushes the branch and the conversation behind it to that repo. I don't do anything else.", cap: "From then on, whenever Claude or I commit, promptlog pushes the branch and the conversation behind it to that repo. I don't do anything else." },
    ],
    tail: 1.0,
  },

  // ---- the review page ----
  overview: {
    url: VIEWER,
    badge: LIVE,
    setup: markOverview,
    sentences: [
      { say: "Here's a branch from that project, opened in prompt log as a pull request.", cap: "Here's a branch from that project, opened in promptlog as a pull request." },
      'At the top is a summary of what changed and why. More than half of this code was written in reply to another agent, not to me.',
      'Each change is described in plain words, with the message that asked for it quoted underneath, and who sent it.',
      { say: "A model writes the summary. Then prompt log checks every quote against the saved conversation, so a made-up reason won't get through.", cap: "A model writes the summary. Then promptlog checks every quote against the saved conversation, so a made-up reason won't get through." },
      "The diff is still here, under the Files tab. I'll come back to it.",
    ],
    timeline: (t) => {
      const d2 = t.ends[2] - t.cues[2];
      return [
        { at: t.c(0, 0.1), hl: '.pr-head', until: t.e(0, 0.2), label: 'a real PR', pad: 8 },
        { at: t.c(1, 0), hl: '#overview > h2', until: t.c(1, 1.6), label: 'the overview', pad: 6 },
        { at: t.c(1, 1.6), hl: '.ov-drove', until: t.e(1, 0.3), label: 'who drove the code', pad: 6 },
        { at: t.c(2, 0), scroll: '#__ov1', offset: -120, dur: 1.2 },
        { at: t.c(2, 1.3), hl: '#__ov1what', until: t.c(2, d2 * 0.5), label: 'what changed', pad: 6 },
        { at: t.c(2, d2 * 0.5), hl: '#__ov1q', until: t.e(2, 0.2), label: 'the message that caused it, and who sent it', pad: 6 },
        { at: t.c(3, 0.2), hl: '#__ov1q', until: t.e(3, 0.3), label: 'checked against the conversation, in code', pad: 6 },
        { at: t.c(4, 0), scroll: 0, dur: 1.0 },
        { at: t.c(4, 1.0), hl: '.pr-tabs', until: t.e(4, 0.6), label: 'the conversation, next to the code', pad: 6 },
      ];
    },
  },

  turns: {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(16), offset: -64 },
    sentences: [
      "Every turn has the same shape: who asked, what they asked, the start of Claude's reply, and the code Claude wrote in that turn.",
      "This is the turn where my Stop button message landed. It came in while Claude was working, so it's shown inside the turn, where Claude actually saw it.",
    ],
    timeline: (t) => {
      const d = t.ends[0] - t.cues[0];
      return [
        { at: t.c(0, d * 0.42), hl: `${T(16)} .pr-turn-head`, until: t.c(0, d * 0.56), label: 'who asked' },
        { at: t.c(0, d * 0.56), hl: `${T(16)} .pr-ask`, until: t.c(0, d * 0.7), label: 'the ask' },
        { at: t.c(0, d * 0.7), hl: `${T(16)} .pr-did`, until: t.c(0, d * 0.85), label: "Claude's reply", below: true },
        { at: t.c(0, d * 0.85), hl: `${T(16)} .pr-files`, until: t.e(0, 0.3), label: 'the code Claude wrote', below: true },
        { at: t.c(1, 0.3), hl: `${T(16)} .pr-mid`, until: t.e(1, 0.8), label: 'sent while Claude was working', pad: 6 },
      ];
    },
    tail: 1.0,
  },

  agents: {
    url: scene('agents.html'),
    setup: async (page) => {
      await page.evaluate(() => document.querySelectorAll('[data-s="3"]').forEach((e) => e.remove()));
    },
    sentences: [
      'Here are the messages other sessions sent to this one while it worked on the branch.',
      'The Blog SEO audit session sent bug reports and retests. The setup session asked it to move to a branch.',
      'Claude handled each message as a new turn, so each one is on the page, next to the code Claude wrote for it.',
      "Without that, these messages would only exist in each session's own history.",
    ],
    tail: 1.0,
  },

  'review-t7': {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(7), offset: -64 },
    setup: async (page) => {
      await page.evaluate((sel) => {
        const lines = [...document.querySelector(`${sel} .pr-files details.pr-file`).querySelectorAll('.pl')];
        const a = lines.findIndex((l) => l.textContent.includes('export function describeRun'));
        const b = lines.findIndex((l, i) => i > a && l.textContent.includes("case 'done':"));
        for (let i = a - 1; i <= b + 1 && i >= 0; i++) lines[i].classList.add('__m7');
      }, T(7));
    },
    sentences: [
      'Earlier turns came from me. Here I asked for the popup to say whether the agent is done, still working, or stalled.',
      'The code Claude wrote for it is right under the ask, so I can check it against what I asked for.',
      "It shows working, stalled, or done, which is what I wanted.",
    ],
    timeline: (t) => [
      { at: t.c(0, 0.2), hl: `${T(7)} .pr-ask`, until: t.e(0, 0.1), label: "the person's ask" },
      { at: t.c(1, 0), click: `${T(7)} .pr-files details.pr-file > summary`, move: 0.8 },
      { at: t.c(1, 0.4), cursor: 'hide' },
      { at: t.c(1, 0.4), scroll: '.__m7', offset: -150, dur: 1.4 },
      { at: t.c(1, 1.7), hl: '.__m7', until: t.e(2, 0.6), label: 'working / stalled / done', pad: 4 },
    ],
    tail: 1.0,
  },

  'review-t13': {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(13), offset: -64 },
    setup: async (page) => {
      await page.evaluate((sel) => {
        // Mark the dangerous paragraph of the field report and the safety lines of the changelog.
        const full = document.querySelector(`${sel} .pr-ask-full`);
        const walker = document.createTreeWalker(full, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const i = n.data.indexOf('- DANGEROUS');
          if (i < 0) continue;
          const j = n.data.indexOf('nothing was saved.', i);
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, j + 'nothing was saved.'.length);
          const span = document.createElement('span');
          span.id = '__dang';
          r.surroundContents(span);
          break;
        }
        const files = [...document.querySelectorAll(`${sel} .pr-files details.pr-file`)];
        const cl = files.find((d) => d.querySelector('.pr-path')?.textContent === 'CHANGELOG.md');
        cl.id = '__cl';
        const lines = [...cl.querySelectorAll('.pl')];
        const a = lines.findIndex((l) => l.textContent.trim().endsWith('Safety'));
        for (let k = a; k <= a + 3; k++) lines[k].classList.add('__safe');
      }, T(13));
    },
    sentences: [
      "Here's the turn where that bug report arrived. The ask came from the other Claude session, not from me.",
      "It's long, so it's folded. I'll open it.",
      { say: 'This is the bug that mattered. On a live domain, the record type was still set to A, and the model typed a verification string into the I P v four field. One more Enter would have saved a broken DNS record.', cap: 'This is the bug that mattered. On a live domain, the record type was still set to A, and the model typed a verification string into the IPv4 field. One more Enter would have saved a broken DNS record.', pause: 1.0 },
      "Under it is the code Claude wrote in this turn. Claude summed it up in the changelog: don't type a value into a field it can't fit, and don't press Save while the form shows an error.",
    ],
    timeline: (t) => [
      { at: t.c(0, 0.1), hl: `${T(13)} .pr-turn-head`, until: t.c(0, 2.8), label: 'not a person' },
      { at: t.c(0, 2.8), hl: `${T(13)} .pr-turn-head .pr-who`, until: t.e(0, 0.2), label: 'another Claude session', pad: 5 },
      { at: t.c(1, 0), hl: `${T(13)} .pr-ask`, until: t.c(1, 1.2), label: 'its field report' },
      { at: t.c(1, 1.3), click: `${T(13)} .pr-more`, move: 0.7 },
      { at: t.c(2, 0), cursor: 'hide' },
      { at: t.c(2, 0), scroll: '#__dang', offset: -230, dur: 1.6 },
      { at: t.c(2, 1.4), hl: '#__dang', until: t.e(2, 0.8), dim: true, pad: 8 },
      { at: t.c(3, 0), scroll: '#__cl', offset: -200, dur: 1.4 },
      { at: t.c(3, 1.0), click: '#__cl > summary', move: 0.7 },
      { at: t.c(3, 1.9), cursor: 'hide' },
      { at: t.c(3, 1.8), scroll: '.__safe', offset: -200, dur: 1.2 },
      { at: t.c(3, 3.0), hl: '.__safe', until: t.e(3, 1.2), label: 'the fix, in the changelog', pad: 4 },
    ],
    tail: 1.3,
  },

  'review-t14': {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(14), offset: -64 },
    sentences: [
      { say: 'The next turn came from a third session, the one I was using to set up prompt log. It passed on my request to move this work onto a branch, and commit as it goes.', cap: 'The next turn came from a third session, the one I was using to set up promptlog. It passed on my request to move this work onto a branch, and commit as it goes.' },
      { say: "So the agent made the branch, and prompt log pushed each commit as it was made. That's the branch we're looking at.", cap: "So the agent made the branch, and promptlog pushed each commit as it was made. That's the branch we're looking at." },
    ],
    timeline: (t) => [
      { at: t.c(0, 0.2), hl: `${T(14)} .pr-turn-head .pr-who`, until: t.c(0, 3.0), label: 'a third session', pad: 5 },
      { at: t.c(0, 3.0), hl: `${T(14)} .pr-ask`, until: t.e(0, 0.3), label: 'a message between agents' },
      { at: t.c(1, 0), hl: `${T(14)} .pr-did`, until: t.e(1, 0.8), label: 'it moved the work onto a branch', below: true },
    ],
    tail: 1.0,
  },

  'review-files': {
    url: VIEWER,
    badge: LIVE,
    start: { y: 0 },
    setup: async (page) => {
      await page.evaluate(() => {
        const f = [...document.querySelectorAll('#files details.pr-file')].find((d) => d.querySelector('.pr-path')?.textContent === 'src/background/agent.ts');
        f.id = '__agent';
        const by = [...f.querySelectorAll('.pr-by')];
        by.find((b) => b.textContent.includes('jkrup')).id = '__by7';
        by.find((b) => b.textContent.includes('turn 13 · Blog SEO audit')).id = '__by13';
      });
    },
    sentences: [
      "Back to the Files tab. It's a normal diff, except every line is labeled with the turn it was written in, and who asked for it.",
      'Clicking a label takes me to that turn, so from any line I can get to the conversation behind it.',
    ],
    timeline: (t) => {
      const d = t.ends[0] - t.cues[0];
      return [
        { at: t.c(0, d * 0.1), click: '.pr-tabs a[href="#files"]', move: 0.8 },
        { at: t.c(0, d * 0.1 + 0.05), scroll: '#files', offset: -60, dur: 0.01 },
        { at: t.c(0, d * 0.25), click: '#__agent > summary', move: 0.8 },
        { at: t.c(0, d * 0.37), cursor: 'hide' },
        { at: t.c(0, d * 0.37), scroll: '#__by7', offset: -160, dur: 1.2 },
        { at: t.c(0, d * 0.5), hl: '#__by7', until: t.c(0, d * 0.74), label: 'turn 7, asked by the person', pad: 4 },
        { at: t.c(0, d * 0.72), scroll: '#__by13', offset: -260, dur: 1.4 },
        { at: t.c(0, d * 0.88), hl: '#__by13', until: t.e(0, 0.4), label: 'asked by another agent', pad: 4 },
        { at: t.c(1, 0.8), click: '#__by13', move: 0.8 },
        { at: t.c(1, 0.9), cursor: 'hide' },
        { at: t.c(1, 1.1), scroll: T(13), offset: -64, dur: 0.01 },
        { at: t.c(1, 1.3), hl: `${T(13)} .pr-turn-head`, until: t.e(1, 0.8), label: 'the turn it was written in' },
      ];
    },
    tail: 1.2,
  },

  // ---- many agents at once ----
  leases: {
    url: scene('leases.html'),
    setup: async (page, { lease }) => {
      await page.evaluate((d) => {
        document.getElementById('deny').textContent = d.reason;
        document.getElementById('headsup').textContent = d.headsUp;
        document.getElementById('leases').textContent = d.table;
      }, lease);
    },
    sentences: [
      { say: 'Prompt log also helps when several agents work in the same repo at once. Here, two agents work in one file, from separate worktrees.', cap: 'promptlog also helps when several agents work in the same repo at once. Here, two agents work in one file, from separate worktrees.' },
      { say: 'Agent A is changing get rates, so it holds a lease on that one function. Agent B edits health, in the same file, which is fine.', cap: 'Agent A is changing getRates(), so it holds a lease on that one function. Agent B edits health(), in the same file, which is fine.' },
      { say: 'When B tries to edit get rates, prompt log blocks the edit, and tells B which agent holds it, on which branch, and what that agent was asked to do.', cap: 'When B tries to edit getRates(), promptlog blocks the edit, and tells B which agent holds it, on which branch, and what that agent was asked to do.', pause: 0.8 },
      { say: 'Then B edits format rates, which sits right under get rates. That is close enough that prompt log asks Clef, a small model, whether the two changes are independent. Clef says yes, so B goes ahead, with a note about its neighbor.', cap: 'Then B edits formatRates(), which sits right under getRates(). That is close enough that promptlog asks Clef, a small model, whether the two changes are independent. Clef says yes (75%), so B goes ahead, with a note about its neighbor.', pause: 0.8 },
      { say: 'Leases are released when a session ends, or after fifteen minutes without activity.', cap: 'Leases are released when a session ends, or after 15 minutes without activity.' },
    ],
    tail: 1.2,
  },

  'leases-web': {
    url: `file://${new URL('./build/leases-web.html', import.meta.url).pathname}`,
    badge: '<b>Hosted</b> &middot; /leases on the public demo repo',
    setup: async (page) => {
      await page.evaluate(() => {
        const d = document.querySelector('.lease-decisions');
        d.id = '__dec';
        (d.querySelector('.allowed') || d).id = '__dec1';
      });
    },
    sentences: ['The lease table is stored on Cloudflare, in a Durable Object, so agents on different machines share it. Every decision is listed on this page.'],
    timeline: (t) => {
      const d = t.ends[0] - t.cues[0];
      return [
        { at: t.c(0, 0.3), hl: '.lease-card', until: t.c(0, d * 0.55), label: 'agents at work, and what they were asked', pad: 6 },
        { at: t.c(0, d * 0.55), scroll: '#__dec', offset: -170, dur: 1.4 },
        { at: t.c(0, d * 0.55 + 1.5), hl: '#__dec1', until: t.e(0, 1.0), label: "Clef's decision", pad: 6 },
      ];
    },
    tail: 1.2,
  },

  arch: {
    url: scene('arch.html'),
    sentences: [
      { say: "Here's how it runs on Cloudflare. Each project gets a private Artifacts repo, and prompt log pushes every commit and its conversation there.", cap: "Here's how it runs on Cloudflare. Each project gets a private Artifacts repo, and promptlog pushes every commit and its conversation there." },
      'The review page is a Worker plus a Container that reads that repo. The summaries and the small yes or no calls run on Workers AI.',
      'Leases live in a Durable Object, one per repo.',
    ],
    tail: 1.2,
  },

  close: {
    url: scene('close.html'),
    setup: async (page) => {
      await page.evaluate(({ c, html }) => {
        document.getElementById('tag').innerHTML = html;
        document.getElementById('repo').textContent = c.repoUrl;
        document.getElementById('demo').textContent = c.demoUrl;
        document.getElementById('home').textContent = c.homeUrl;
      }, { c: CONFIG, html: TAGLINE_HTML });
    },
    sentences: [
      { say: "That's prompt log. The conversation behind the code is saved with it, and you can read it right in the pull request.", cap: "That's promptlog. The conversation behind the code is saved with it, and you can read it right in the pull request." },
      "It's open source, under MIT. The code and a live demo are at these links.",
    ],
    tail: 2.5,
  },
};
