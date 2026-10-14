// The demo's script: narration (one entry per sentence) and what happens on screen.
// A sentence is a string, or { say, cap } when the spoken text differs from the caption.
// Timelines get t = { c(i, d), e(i, d), cues, ends, dur }: c = start of sentence i (+d s), e = its end.
// Timeline steps: scroll (selector | number | {by}), click (selector, cursor glides there first),
// hl (highlight box, optional label), cursor ('hide'). See build.mjs for the engine.

export const CONFIG = {
  voice: 'Samantha',
  rate: 175,
  repoUrl: 'github.com/jkrup/promptlog',
  demoUrl: 'promptlog-viewer.mazlix-f8e.workers.dev/review?base=main&head=feature%2Frates&repo=promptlog-demo',
  homeUrl: 'promptlog-home.mazlix-f8e.workers.dev',
};

// Order of the final cut. Each id is its own segment (build/seg-<id>.mp4 + .wav), so scenes can be
// re-rendered or re-ordered without touching the rest.
export const ORDER = ['title', 'problem', 'setup', 'overview', 'review-t16', 'review-turns', 'review-t7', 'review-t13', 'review-t14', 'review-files', 'arch', 'agents', 'leases', 'leases-web', 'close'];

const VIEWER = 'http://[::1]:4812/review?base=main&head=clef-visibility-and-safety';
const LIVE = '<b>Live</b> &middot; the real pull request, in promptlog';
const T = (id) => `#t-a76c927d-${id}`;
const scene = (f) => `file://${new URL(`./scenes/${f}`, import.meta.url).pathname}`;

export const SCENES = {
  title: {
    url: scene('title.html'),
    lead: 0.9,
    tail: 1.6,
    sentences: [{ say: 'This is prompt log. Review the conversation that built the code, not just the diff.', cap: 'This is promptlog. Review the conversation that built the code, not just the diff.' }],
  },

  problem: {
    url: scene('problem.html'),
    sentences: [
      'Agents write most of the code now.',
      'But code review still means reading the output: a diff, line by line.',
      'The reasons live somewhere else. What was asked, what the agent tried, where the person pushed back, and what never got tested: all of that is in the conversation, and the conversation gets thrown away.',
      "And now agents talk to each other. One agent finds a bug and reports it, another one fixes it. A diff can't show you that.",
      { say: 'Code is the compiled output now. The prompts and the conversation are the source. Prompt log lets you review that.', cap: 'Code is the compiled output now. The prompts and the conversation are the source. promptlog lets you review that.' },
    ],
    tail: 1.2,
  },

  setup: {
    url: scene('setup.html'),
    sentences: [
      { say: 'Setup is one command, in any folder: prompt log connect.', cap: 'Setup is one command, in any folder: promptlog connect.' },
      "It sets up git if the folder doesn't have it yet, and adds recording hooks to Claude Code.",
      'It creates a private repo on Cloudflare Artifacts, named after the folder, and keeps the login in the Mac keychain.',
      "It brings in the folder's past Claude Code sessions and links each one to the commits it made. Here: two sessions, twenty-two turns, six commits.",
      'Then it pushes.',
      'After that, nothing changes in how you work. Every commit, by a person or an agent, pushes the branch and its conversation in the background. A branch is a pull request.',
    ],
    tail: 1.0,
  },

  arch: {
    url: scene('arch.html'),
    sentences: [
      'Here is how it runs on Cloudflare.',
      'Several Claude Code sessions work in the same repo. Each commit pushes the code, and the conversation behind it, to a private Cloudflare Artifacts repo.',
      'Each push also sends an event to a Queue.',
      { say: 'The review page is served by a Worker, with a Container that runs the prompt log viewer straight from the Artifacts repo.', cap: 'The review page is served by a Worker, with a Container that runs the promptlog viewer straight from the Artifacts repo.' },
      'For AI it uses Workers AI: DeepSeek writes the plain-language text, and Clef flash makes the small yes-or-no decisions. There are no API keys inside the container.',
      'And leases live in a Durable Object, one per repo. It keeps track of which agent is editing what, and asks Clef when two agents work side by side.',
    ],
    tail: 1.2,
  },

  overview: {
    url: VIEWER,
    badge: LIVE,
    setup: async (page) => {
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.ov-chg')];
        const safe = cards.find((c) => c.textContent.includes('"IPv4 address" field for input'));
        safe.id = '__ovsafe';
        safe.querySelector('.ov-model').id = '__ovwhat';
        safe.querySelector('blockquote.ov-q').id = '__ovq';
        safe.querySelector('.ov-res').closest('blockquote').id = '__ovtried';
        const stop = cards.find((c) => c.textContent.includes('we need a stop buddton'));
        stop.id = '__ovstop';
        [...stop.querySelectorAll('blockquote.ov-q')].find((q) => q.textContent.includes('stop buddton')).id = '__ovstopq';
      });
    },
    sentences: [
      'This is a real pull request, as a reviewer opens it: a Chrome extension called Clef Browser. Seven commits, eighteen files.',
      { say: 'At the top: what changed, and why. Fifty-nine percent of this code answered another agent.', cap: 'At the top: what changed, and why. 59% of this code answered another agent.' },
      'A model groups the work into changes. Each one says what changed, in plain words, then quotes the reason word for word, with who said it.',
      'This reason came from the Blog SEO audit agent, which was using the extension on live sites. And it was tried for real: the retest says it worked.',
      "The quotes are checked against the conversation in code, so a reason can't be made up.",
      { say: 'This change is the Stop button. Its reason is a message the person sent while Claude was busy: your fixes not working, and we need a stop button.', cap: 'This change is the Stop button. Its reason is a message the person sent while Claude was busy: "your fixes not working and we need a stop buddton".' },
    ],
    timeline: (t) => {
      const d2 = t.ends[2] - t.cues[2], d3 = t.ends[3] - t.cues[3];
      return [
        { at: t.c(0, 0.1), hl: '.pr-head', until: t.e(0, 0.2), label: 'a real PR', pad: 8 },
        { at: t.c(1, 0), hl: '#overview > h2', until: t.c(1, 1.7), label: 'the overview', pad: 6 },
        { at: t.c(1, 1.7), hl: '.ov-drove', until: t.e(1, 0.3), label: 'who drove the code', pad: 6 },
        { at: t.c(2, 0), scroll: '#__ovsafe', offset: -96, dur: 1.4 },
        { at: t.c(2, 1.5), hl: '#__ovwhat', until: t.c(2, d2 * 0.55), label: 'what changed', pad: 6 },
        { at: t.c(2, d2 * 0.55), hl: '#__ovq', until: t.e(2, 0.2), label: 'the reason, word for word', pad: 6 },
        { at: t.c(3, 0), hl: '#__ovq .ov-who', until: t.c(3, d3 * 0.55), label: 'another agent', pad: 5 },
        { at: t.c(3, d3 * 0.55), hl: '#__ovtried', until: t.e(3, 0.3), label: 'tried for real', pad: 6, below: true },
        { at: t.c(4, 0.6), scroll: '#__ovstop', offset: -160, dur: 2.2 },
        { at: t.c(5, 0), hl: '#__ovstop', until: t.c(5, 2.2), pad: 6 },
        { at: t.c(5, 2.2), hl: '#__ovstopq', until: t.e(5, 0.8), label: 'sent while Claude was working', pad: 6 },
      ];
    },
  },

  'review-t16': {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(16), offset: -64 },
    sentences: [
      { say: "And here is that message, inside turn sixteen. It arrived while Claude was working, so it's shown inside the turn it landed in, with who sent it.", cap: "And here is that message, inside turn 16. It arrived while Claude was working, so it's shown inside the turn it landed in, with who sent it." },
      "Claude's reply: it committed the Stop button.",
    ],
    timeline: (t) => [
      { at: t.c(0, 0.4), hl: `${T(16)} .pr-mid`, until: t.e(0, 0.3), label: 'arrived while Claude was working', pad: 6 },
      { at: t.c(1, 0), hl: `${T(16)} .pr-did`, until: t.e(1, 0.8), label: "Claude's reply", below: true },
    ],
    tail: 0.8,
  },

  'review-turns': {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(5), offset: -64 },
    sentences: [
      'Below the overview, the page reads like the conversation.',
      "Each turn shows who asked, what they asked, the start of Claude's reply, and the code that turn wrote.",
    ],
    timeline: (t) => {
      const d = t.ends[1] - t.cues[1];
      return [
        { at: t.c(1, 0), hl: `${T(5)} .pr-turn-head`, until: t.c(1, d * 0.22), label: 'who asked' },
        { at: t.c(1, d * 0.22), hl: `${T(5)} .pr-ask`, until: t.c(1, d * 0.45), label: 'the ask' },
        { at: t.c(1, d * 0.45), hl: `${T(5)} .pr-did`, until: t.c(1, d * 0.7), label: "Claude's reply", below: true },
        { at: t.c(1, d * 0.7), hl: `${T(5)} .pr-files`, until: t.e(1, 0.6), label: 'the code this turn wrote', below: true },
      ];
    },
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
      'Turn seven. The person asks for more visibility: is the agent done, still working, or stalled? And how many tokens did it spend?',
      "Right below is the start of Claude's reply.",
      'Then the code this turn wrote: a status line in the popup that says working, stalled, or done.',
      'You read the ask and the code together, so you can check that the code does what was asked.',
    ],
    timeline: (t) => [
      { at: t.c(0, 0.2), hl: `${T(7)} .pr-ask`, until: t.e(0, 0.2), label: "the person's ask" },
      { at: t.c(1, 0), hl: `${T(7)} .pr-did`, until: t.e(1, 0.3), label: "Claude's reply", below: true },
      { at: t.c(2, 0), click: `${T(7)} .pr-files details.pr-file > summary`, move: 0.8 },
      { at: t.c(2, 0.4), cursor: 'hide' },
      { at: t.c(2, 0.4), scroll: '.__m7', offset: -150, dur: 1.4 },
      { at: t.c(2, 1.8), hl: '.__m7', until: t.e(3, 0.5), label: 'working / stalled / done', pad: 4 },
    ],
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
      "Turn thirteen wasn't asked by a person.",
      'It came from another Claude session, called Blog SEO audit. That agent was using the extension on live sites to set up Google Search Console and Cloudflare DNS, and it hit bugs.',
      'So it sent a field report to the session building the extension.',
      { say: 'The worst one: with the record type still set to A, the model typed a verification string into the I P v four address field. One more Enter would have saved a broken record on a live production domain.', cap: 'The worst one: with the record type still set to A, the model typed a verification string into the IPv4 address field. One more Enter would have saved a broken record on a live production domain.' },
      "In this turn, Claude made the extension refuse to type a value into a field it can't fit, and refuse to press Save while the form shows an error.",
    ],
    timeline: (t) => [
      { at: t.c(0, 0.1), hl: `${T(13)} .pr-turn-head`, until: t.e(0, 0.3), label: 'not a person' },
      { at: t.c(1, 0), hl: `${T(13)} .pr-turn-head .pr-who`, until: t.e(1, 0.2), label: 'another Claude session', pad: 5 },
      { at: t.c(2, 0), hl: `${T(13)} .pr-ask`, until: t.c(2, 1.6), label: 'its field report' },
      { at: t.c(2, 2.4), click: `${T(13)} .pr-more`, move: 0.8 },
      { at: t.c(3, 0), cursor: 'hide' },
      { at: t.c(3, 0), scroll: '#__dang', offset: -230, dur: 1.6 },
      { at: t.c(3, 1.4), hl: '#__dang', until: t.e(3, 0.4), dim: true, pad: 8 },
      { at: t.c(4, 0), scroll: '#__cl', offset: -200, dur: 1.4 },
      { at: t.c(4, 1.0), click: '#__cl > summary', move: 0.7 },
      { at: t.c(4, 1.9), cursor: 'hide' },
      { at: t.c(4, 1.8), scroll: '.__safe', offset: -200, dur: 1.2 },
      { at: t.c(4, 3.0), hl: '.__safe', until: t.e(4, 1.2), label: 'the fix, in the changelog', pad: 4 },
    ],
  },

  'review-t14': {
    url: VIEWER,
    badge: LIVE,
    start: { sel: T(14), offset: -64 },
    sentences: [
      { say: 'Turn fourteen came from a third session: the one that set up prompt log in this folder.', cap: 'Turn 14 came from a third session: the one that set up promptlog in this folder.' },
      "It passed on an instruction from the person: move your work off main onto a branch, commit as you go, and don't merge.",
      'The agent did. Its commits pushed themselves, and this page is the result.',
    ],
    timeline: (t) => [
      { at: t.c(0, 0.2), hl: `${T(14)} .pr-turn-head .pr-who`, until: t.e(0, 0.3), label: 'the session that set up promptlog', pad: 5 },
      { at: t.c(1, 0), hl: `${T(14)} .pr-ask`, until: t.e(1, 0.3), label: 'a message between agents' },
      { at: t.c(2, 0), hl: `${T(14)} .pr-did`, until: t.e(2, 0.8), label: 'it moved the work onto a branch', below: true },
    ],
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
      'The Files tab is the diff you know, with one difference.',
      'Every changed line says which turn wrote it, and who asked for it: the person, or another agent.',
      "Click a credit, and you're at that turn: the ask, the reply, and the code.",
      { say: "For sessions recorded live, the credit comes from exact before-and-after snapshots. For older sessions, prompt log matches the code inside each turn's own tool calls.", cap: "For sessions recorded live, the credit comes from exact before-and-after snapshots. For older sessions, promptlog matches the code inside each turn's own tool calls." },
    ],
    timeline: (t) => [
      { at: t.c(0, 0.9), click: '.pr-tabs a[href="#files"]', move: 0.8 },
      { at: t.c(0, 0.95), scroll: '#files', offset: -60, dur: 0.01 },
      { at: t.c(0, 2.0), click: '#__agent > summary', move: 0.8 },
      { at: t.c(1, 0), cursor: 'hide' },
      { at: t.c(1, 0), scroll: '#__by7', offset: -160, dur: 1.2 },
      { at: t.c(1, 1.2), hl: '#__by7', until: t.c(1, 3.4), label: 'written in turn 7, asked by the person', pad: 4 },
      { at: t.c(1, 3.2), scroll: '#__by13', offset: -260, dur: 1.6 },
      { at: t.c(1, 4.8), hl: '#__by13', until: t.e(1, 0.4), label: 'asked by another agent', pad: 4 },
      { at: t.c(2, 1.0), click: '#__by13', move: 0.8 },
      { at: t.c(2, 1.1), cursor: 'hide' },
      { at: t.c(2, 1.3), scroll: T(13), offset: -64, dur: 0.01 },
      { at: t.c(2, 1.5), hl: `${T(13)} .pr-turn-head`, until: t.e(3, 0.5), label: 'turn 13' },
    ],
  },

  agents: {
    url: scene('agents.html'),
    sentences: [
      'This is what working with many agents looks like.',
      'Sessions message each other, and each message becomes a turn on the page: you see who sent it, and the code it caused.',
      'Each agent works on its own branch, and each branch is a pull request.',
      "Every agent's commits arrive with their reasons attached, so a reviewer can check the why, not just the what.",
    ],
    tail: 1.0,
  },

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
      'New: many agents on one repo, even in one file, without collisions.',
      { say: 'Agent A is adding a cache. It edits get rates in server dot J S, so it holds a lease on just that function.', cap: 'Agent A is adding a cache. It edits getRates() in server.js, so it holds a lease on just that function.' },
      { say: "Agent B, in another worktree, edits health in the same file. That's allowed. Then it tries get rates. Prompt log's hook stops that edit, and tells it who holds the function, on which branch, and what they were asked.", cap: "Agent B, in another worktree, edits health() in the same file. That's allowed. Then it tries getRates(). promptlog's hook stops that edit, and tells it who holds the function, on which branch, and what they were asked." },
      { say: 'Next, B edits format rates, right under get rates. That is a gray zone, so Clef asks one narrow question: are the two changes independent? Yes, seventy five percent, so B goes ahead, with a heads-up about its neighbour. Below seventy percent, it would be refused.', cap: 'Next, B edits formatRates(), right under getRates(). That is a gray zone, so Clef asks one narrow question: are the two changes independent? Yes (75%), so B goes ahead, with a heads-up about its neighbour. Below 70%, it would be refused.' },
      { say: 'Prompt log leases shows who holds which functions, and every Clef decision. Leases end when a session ends, or after fifteen quiet minutes, and they are shared across worktrees and machines.', cap: '`promptlog leases` shows who holds which functions, and every Clef decision. Leases end when a session ends, or after 15 quiet minutes, and they are shared across worktrees and machines.' },
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
    sentences: [
      'The lease table lives on Cloudflare, so agents on different machines share it.',
      'The hosted leases page shows who holds which functions, and every Clef decision, in plain words.',
    ],
    timeline: (t) => [
      { at: t.c(0, 0.3), hl: '.lease-card', until: t.e(0, 0.3), label: 'agents at work, and what they were asked', pad: 6 },
      { at: t.c(1, 0), scroll: '#__dec', offset: -170, dur: 1.4 },
      { at: t.c(1, 1.5), hl: '#__dec1', until: t.e(1, 1.0), label: "Clef's decision", pad: 6 },
    ],
    tail: 1.2,
  },

  close: {
    url: scene('close.html'),
    setup: async (page) => {
      await page.evaluate((c) => {
        document.getElementById('repo').textContent = c.repoUrl;
        document.getElementById('demo').textContent = c.demoUrl;
        document.getElementById('home').textContent = c.homeUrl;
      }, CONFIG);
    },
    sentences: [
      { say: 'Prompt log. Review the conversation, not just the diff.', cap: 'promptlog. Review the conversation, not just the diff.' },
      "It's MIT licensed. The live demo is public, and the links are on screen.",
    ],
    tail: 2.5,
  },
};
