// The demo's script: narration (one entry per sentence) and what happens on screen.
// A sentence is a string, or { say, cap } when the spoken text differs from the caption.
// Timelines get t = { c(i, d), e(i, d), cues, ends, dur }: c = start of sentence i (+d s), e = its end.
// Timeline steps: scroll (selector | number | {by}), click (selector, cursor glides there first),
// hl (highlight box, optional label), cursor ('hide'). See build.mjs for the engine.

export const CONFIG = {
  voice: 'Samantha',
  rate: 175,
  repoUrl: 'github.com/<repo link TBD>',
};

// Order of the final cut. Each id is its own segment (build/seg-<id>.mp4 + .wav), so scenes can be
// re-rendered or re-ordered without touching the rest.
export const ORDER = ['title', 'problem', 'setup', 'arch', 'review-head', 'review-t7', 'review-t13', 'review-t14', 'review-files', 'agents', 'leases', 'concept', 'close'];

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
    ],
    tail: 1.2,
  },

  'review-head': {
    url: VIEWER,
    badge: LIVE,
    sentences: [
      'This is a real pull request, on a Chrome extension called Clef Browser.',
      'Seven commits, eighteen files, about eleven hundred lines.',
      { say: 'Prompt log traced ninety-six percent of the changed lines to the turn that wrote them.', cap: 'promptlog traced 96% of the changed lines to the turn that wrote them.' },
      "The page reads like the conversation. Each turn shows who asked, what they asked, the start of Claude's reply, and the code that turn wrote.",
    ],
    timeline: (t) => {
      const s3 = t.ends[3] - t.cues[3];
      return [
        { at: t.c(0, 0.1), hl: '.pr-range, .pr-head h1', until: t.e(0, 0.2), label: 'a real PR' },
        { at: t.c(1, 0), hl: '.pr-meta', until: t.e(1, 0.2) },
        { at: t.c(2, 0), hl: '.pr-cover', until: t.e(2, 0.3), label: 'each line traced to its turn' },
        { at: t.c(3, 0), scroll: T(5), offset: -64, dur: 1.4 },
        { at: t.c(3, s3 * 0.25), hl: `${T(5)} .pr-turn-head`, until: t.c(3, s3 * 0.42), label: 'who asked' },
        { at: t.c(3, s3 * 0.42), hl: `${T(5)} .pr-ask`, until: t.c(3, s3 * 0.6), label: 'the ask' },
        { at: t.c(3, s3 * 0.6), hl: `${T(5)} .pr-did`, until: t.c(3, s3 * 0.8), label: "Claude's reply", below: true },
        { at: t.c(3, s3 * 0.8), hl: `${T(5)} .pr-files`, until: t.e(3, 0.6), label: 'the code this turn wrote', below: true },
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
      "In this pull request, more than half of the new code answers that agent's reports.",
    ],
    timeline: (t) => [
      { at: t.c(0, 0.1), hl: `${T(13)} .pr-turn-head`, until: t.e(0, 0.3), label: 'not a person' },
      { at: t.c(1, 0), hl: `${T(13)} .pr-who`, until: t.e(1, 0.2), label: 'another Claude session', pad: 5 },
      { at: t.c(2, 0), hl: `${T(13)} .pr-ask`, until: t.c(2, 1.6), label: 'its field report' },
      { at: t.c(2, 2.4), click: `${T(13)} .pr-more`, move: 0.8 },
      { at: t.c(3, 0), cursor: 'hide' },
      { at: t.c(3, 0), scroll: '#__dang', offset: -230, dur: 1.6 },
      { at: t.c(3, 1.4), hl: '#__dang', until: t.e(3, 0.4), dim: true, pad: 8 },
      { at: t.c(4, 0), scroll: '#__cl', offset: -200, dur: 1.4 },
      { at: t.c(4, 1.0), click: '#__cl > summary', move: 0.7 },
      { at: t.c(4, 1.9), cursor: 'hide' },
      { at: t.c(4, 1.8), scroll: '.__safe', offset: -200, dur: 1.2 },
      { at: t.c(4, 3.0), hl: '.__safe', until: t.e(5, 0.6), label: 'the fix, in the changelog', pad: 4 },
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
      { at: t.c(0, 0.2), hl: `${T(14)} .pr-who`, until: t.e(0, 0.3), label: 'the session that set up promptlog', pad: 5 },
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
        document.getElementById('leases').textContent = d.table;
      }, lease);
    },
    sentences: [
      'New: many agents on one repo, without collisions.',
      { say: 'Two agents, one file. Agent A is adding a cache. It edits server dot J S first, so it holds a lease on that file.', cap: 'Two agents, one file. Agent A is adding a cache. It edits server.js first, so it holds a lease on that file.' },
      { say: "Agent B, in another worktree, tries to edit the same file. Prompt log's hook stops the edit, and tells it who holds the file, on which branch, and what they were asked.", cap: "Agent B, in another worktree, tries to edit the same file. promptlog's hook stops the edit, and tells it who holds the file, on which branch, and what they were asked." },
      'So agent B works on something else first, or messages the other agent.',
      { say: 'Prompt log leases shows who holds what. A lease ends when its session ends, or after fifteen quiet minutes. And leases are shared across every worktree of the repo.', cap: '`promptlog leases` shows who holds what. A lease ends when its session ends, or after 15 quiet minutes. And leases are shared across every worktree of the repo.' },
    ],
    tail: 1.2,
  },

  concept: {
    url: scene('../../docs/concepts/pr4.html'),
    badge: '<b>Concept</b> &middot; not built yet',
    badgePos: 'center',
    setup: async (page) => {
      await page.evaluate(() => {
        const h = [...document.querySelectorAll('h2')].find((e) => e.textContent.startsWith('What changed, and why'));
        h.id = '__chg';
        const live = document.querySelector('button.live');
        live.id = '__live1';
        const card = live.parentElement.parentElement;
        card.id = '__card1';
        const quote = [...card.querySelectorAll('*')].filter((e) => e.textContent.includes('the model typed') && e.textContent.trim().startsWith('Blog SEO audit')).pop();
        quote.id = '__q1';
        const ok = document.querySelector('button.live.ok');
        ok.id = '__live2';
      });
    },
    sentences: [
      "What's next. This part is a concept: it isn't built yet.",
      'Instead of reading turn by turn, the overview groups the pull request by what changed.',
      'Each change comes with the exact words that caused it, and who said them.',
      'And the last chip says whether anyone has tried it on a live page.',
    ],
    timeline: (t) => [
      { at: t.c(1, 0), scroll: '#__chg', offset: -90, dur: 1.6 },
      { at: t.c(1, 1.6), hl: '#__card1', until: t.e(1, 0.3), pad: 4 },
      { at: t.c(2, 0), hl: '#__q1', until: t.e(2, 0.3), label: 'verbatim, with who said it', pad: 4 },
      { at: t.c(3, 0), hl: '#__live1', until: t.c(3, 1.8), label: 'partly tried live', pad: 4, below: true },
      { at: t.c(3, 1.2), scroll: '#__live2', offset: -420, dur: 1.2 },
      { at: t.c(3, 2.4), hl: '#__live2', until: t.e(3, 1.0), label: 'confirmed live', pad: 4, below: true },
    ],
    tail: 1.2,
  },

  close: {
    url: scene('close.html'),
    setup: async (page) => {
      await page.evaluate((u) => (document.getElementById('repo').textContent = u), CONFIG.repoUrl);
    },
    sentences: [
      { say: 'Prompt log. Review the conversation, not just the diff.', cap: 'promptlog. Review the conversation, not just the diff.' },
      "It's MIT licensed, and the links are on screen.",
    ],
    tail: 2.5,
  },
};
