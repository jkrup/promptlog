// Read-only git lookups that feed the renderer: final diff, per-turn diffs, commit bodies, and the author's
// checkout root (so absolute paths in tool calls render repo-relative). Never touches the index or worktree.
import { gitMaybe } from '../core/git.ts';
import { diffTrees } from '../core/store.ts';
import type { Review, Turn } from '../core/types.ts';
import type { GitContext } from './render.ts';

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3'];

function diff(cwd: string, a: string, b: string): string {
  return gitMaybe([...DIFF_ARGS, a, b, '--'], { cwd }) ?? '';
}

const TRAILER_LINE = /^(Co-Authored-By|Signed-off-by|Promptlog|Change-Id|Claude-Session):/i;

function commitBodies(cwd: string, review: Review): Record<string, string> {
  if (!review.commits.length) return {};
  const out = gitMaybe(['log', '--format=%H%x1f%b%x1e', `${review.mergeBase}..${review.head}`], { cwd }) ?? '';
  const bodies: Record<string, string> = {};
  for (const rec of out.split('\x1e')) {
    const [sha, body] = rec.trim().split('\x1f') as [string, string | undefined];
    if (!sha) continue;
    bodies[sha] = (body ?? '')
      .split('\n')
      .filter((l) => !TRAILER_LINE.test(l.trim()))
      .join('\n')
      .trim();
  }
  return bodies;
}

/** Absolute paths mentioned by file tools, e.g. /home/dana/repo/src/x.ts. */
export function absolutePathsInTurns(turns: Turn[]): string[] {
  const paths = new Set<string>();
  for (const t of turns)
    for (const it of t.items) {
      if (it.kind !== 'tool' || !it.input || typeof it.input !== 'object') continue;
      const i = it.input as Record<string, unknown>;
      for (const k of ['file_path', 'notebook_path', 'path']) {
        const v = i[k];
        if (typeof v === 'string' && v.startsWith('/')) paths.add(v);
      }
    }
  return [...paths];
}

/**
 * Work out the author's checkout root(s) from absolute paths: the prefix left after removing the longest
 * suffix that is a repo-relative path. Returns prefixes with a trailing '/'.
 */
export function deriveRootPrefixes(absPaths: string[], repoFiles: Set<string>): string[] {
  const prefixes = new Set<string>();
  for (const p of absPaths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const rel = segs.slice(i).join('/');
      if (repoFiles.has(rel)) {
        prefixes.add(segs.slice(0, i).join('/') + '/');
        break;
      }
    }
  }
  return [...prefixes];
}

function lsFiles(cwd: string, treeish: string | undefined): string[] {
  if (!treeish) return [];
  return (gitMaybe(['ls-tree', '-r', '--name-only', treeish], { cwd }) ?? '').split('\n').filter(Boolean);
}

export function collectGitContext(cwd: string, review: Review): GitContext {
  const ctx: GitContext = {
    finalDiff: diff(cwd, review.mergeBase, review.head),
    finalFiles: [],
    turnDiffs: {},
    betweenTurns: {},
    commitBodies: commitBodies(cwd, review),
    rootPrefixes: [],
  };
  try {
    ctx.finalFiles = diffTrees(cwd, review.mergeBase, review.head);
  } catch {
    ctx.finalFiles = [];
  }

  const repoFiles = new Set<string>([...lsFiles(cwd, review.head), ...lsFiles(cwd, review.mergeBase)]);
  const allTurns: Turn[] = [];
  for (const sl of review.slices) {
    const s = review.sessions[sl.sessionId];
    if (!s) continue;
    const turns = s.turns.filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn);
    allTurns.push(...turns);
    const last = turns[turns.length - 1]?.meta?.stateAfter;
    for (const f of lsFiles(cwd, last)) repoFiles.add(f);
    for (const t of turns) {
      const m = t.meta;
      const key = `${sl.sessionId}#${t.index}`;
      if (m?.stateBefore && m.stateAfter && m.stateBefore !== m.stateAfter) ctx.turnDiffs[key] = diff(cwd, m.stateBefore, m.stateAfter);
      const prev = s.turns.find((x) => x.index === t.index - 1)?.meta?.stateAfter;
      if (prev && m?.stateBefore && prev !== m.stateBefore) {
        try {
          const files = diffTrees(cwd, prev, m.stateBefore);
          if (files.length) ctx.betweenTurns[key] = { files, patch: diff(cwd, prev, m.stateBefore) };
        } catch {
          // Snapshot objects missing (e.g. shallow fetch): skip.
        }
      }
    }
  }
  ctx.rootPrefixes = deriveRootPrefixes(absolutePathsInTurns(allTurns), repoFiles);
  return ctx;
}
