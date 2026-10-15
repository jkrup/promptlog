// A short "what you're looking at" guide on top of a public demo repo's review page, plus the repo's real name in
// the title and breadcrumb (the container's clone is a folder called "repo"). Added here, in the Worker, so the
// demo can be explained without changing the viewer.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Guides by repo name. The steps point at this repo's own turns, so each demo repo gets its own. */
const GUIDES: Record<string, (repo: string) => string> = {
  'promptlog-demo': (repo) => `
<p>This is a real pull request from a small demo project: a currency-rates API that a developer, Dana, built with Claude Code. promptlog saved each conversation and shows it next to the code Claude wrote.</p>
<ol>
<li><a href="#overview">What changed, and why</a>: each change, with the message that asked for it.</li>
<li><a href="#t-e2741880-2">Turn 2</a>: Dana pushes back on Claude's cache ("we run ~20 instances&hellip;"). The code Claude wrote in reply is right under it.</li>
<li><a href="#files">Files</a>: each changed line is labeled with the turn it came from. Click a label to jump to that turn.</li>
<li><a href="/leases?repo=${esc(repo)}">Who's working on what</a>: this repo's lease table, and the calls Clef made when two agents edited the same file.</li>
</ol>`,
};

const STYLE = `
.pl-guide{position:relative;margin:4px 0 22px;padding:18px 44px 16px 20px;border:1px solid var(--border-strong);border-left:4px solid var(--ai);border-radius:12px;background:var(--surface);color:var(--text);font-size:15px;line-height:1.5}
.pl-guide h2{margin:0 0 6px;font-size:17px;line-height:1.3}
.pl-guide p{margin:0 0 10px;color:var(--text-2)}
.pl-guide ol{margin:0 0 12px;padding-left:22px}
.pl-guide li{margin:5px 0}
.pl-guide a{color:var(--accent)}
.pl-guide .pl-links{display:flex;gap:18px;flex-wrap:wrap;font-size:14px}
.pl-guide .pl-x{position:absolute;top:8px;right:8px;border:0;background:none;color:var(--muted);font-size:22px;line-height:1;cursor:pointer;padding:6px 10px}`;

function guideHtml(repo: string, body: string): string {
  return `<aside class="pl-guide" id="pl-guide" aria-label="About this demo"><style>${STYLE}</style>
<button type="button" class="pl-x" aria-label="Hide this guide" onclick="document.getElementById('pl-guide').hidden=true;try{localStorage.setItem('pl-guide-${esc(repo)}','hidden')}catch(e){}">&times;</button>
<h2>You're looking at a promptlog demo</h2>${body}
<div class="pl-links"><a href="https://promptlog-home.mazlix-f8e.workers.dev">What is promptlog?</a><a href="https://github.com/jkrup/promptlog">Code on GitHub</a></div>
</aside>
<script>try{if(localStorage.getItem('pl-guide-${esc(repo)}')==='hidden')document.getElementById('pl-guide').hidden=true}catch(e){}</script>`;
}

/** Rewrites a review page for a public repo: real repo name in the title and breadcrumb, and the guide if it has one. */
export function withDemoGuide(res: Response, repo: string): Response {
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  const guide = GUIDES[repo];
  let crumbDone = false;
  let rw = new HTMLRewriter()
    .on('title', {
      text(t) {
        if (t.text.includes(' · repo')) t.replace(t.text.replace(' · repo', ` · ${esc(repo)}`), { html: true });
      },
    })
    .on('nav.crumbs span', {
      text(t) {
        if (!crumbDone && t.text === 'repo') {
          t.replace(repo);
          crumbDone = true;
        }
      },
    });
  if (guide) rw = rw.on('header.pr-head', { element: (el) => el.before(guideHtml(repo, guide(repo)), { html: true }) });
  return rw.transform(res);
}
