// Git-backed session store. See docs/format.md.
//
// refs/promptlog/sessions/<sessionId>  -> append-only commit chain, one commit per capture.
// Each commit's tree:
//   session.json
//   turns/000001/meta.json
//   turns/000001/transcript.jsonl      raw transcript lines for this turn (redacted)
//   turns/000001/before                tree: working tree when the prompt was submitted
//   turns/000001/after                 tree: working tree when the agent stopped
//   turns/000001/subagents/<id>.jsonl  optional subagent transcripts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { catFileBatch, currentBranch, git, gitDir, gitMaybe, hashBlob, headSha, lsTree, mktree, type TreeEntry } from './git.ts';
import { normalize, splitByTurn, transcriptFacts } from './transcript.ts';
import { REF_PREFIX, SCHEMA_VERSION, type FileChange, type Session, type SessionMeta, type TurnMeta } from './types.ts';

export const turnDirName = (index: number) => String(index).padStart(6, '0');
export const sessionRef = (sessionId: string) => REF_PREFIX + sessionId;

/** Hook for redaction (capture/redact.ts plugs in here). Identity by default. */
export type Redactor = (text: string) => string;

// ---------------------------------------------------------------------------
// Local, unpushed per-worktree state: <git-dir>/promptlog/
// ---------------------------------------------------------------------------

export interface PendingTurn {
  startedAt: string;
  headBefore?: string;
  stateBefore?: string;
  branch?: string;
}

export interface LocalSessionState {
  sessionId: string;
  transcriptPath: string;
  startedAt: string;
  pending?: PendingTurn;
  /** Turns captured since the last commit in this worktree; consumed by the commit trailer hook. */
  turnsSinceCommit?: number[];
  lastActivityAt?: string;
  ended?: boolean;
}

export function localDir(cwd: string): string {
  const dir = join(gitDir(cwd), 'promptlog');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return dir;
}

export function readLocalState(cwd: string, sessionId: string): LocalSessionState | null {
  const p = join(localDir(cwd), 'sessions', `${sessionId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LocalSessionState;
  } catch {
    return null;
  }
}

export function writeLocalState(cwd: string, state: LocalSessionState): void {
  writeFileSync(join(localDir(cwd), 'sessions', `${state.sessionId}.json`), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Snapshot the working tree (tracked + untracked-but-not-ignored files) into a git tree without touching
 * the user's index or worktree. Uses a persistent per-session temp index so re-snapshots only rehash changed files.
 */
export function snapshotWorktree(root: string, sessionId: string): string {
  const indexFile = join(localDir(root), `index-${sessionId}`);
  const env = { GIT_INDEX_FILE: indexFile };
  if (!existsSync(indexFile)) {
    const head = headSha(root);
    if (head) git(['read-tree', head], { cwd: root, env });
  }
  git(['add', '-A', '--', '.'], { cwd: root, env });
  return git(['write-tree'], { cwd: root, env });
}

export function diffTrees(root: string, a: string, b: string): FileChange[] {
  if (a === b) return [];
  const status = git(['diff-tree', '-r', '-M', '--name-status', '-z', a, b], { cwd: root }).split('\0').filter(Boolean);
  const numstat = git(['diff-tree', '-r', '-M', '--numstat', '-z', a, b], { cwd: root });
  const changes: FileChange[] = [];
  for (let i = 0; i < status.length; ) {
    const code = status[i]!;
    const s = code[0] as FileChange['status'];
    if (s === 'R' || s === 'C') {
      changes.push({ status: s, oldPath: status[i + 1]!, path: status[i + 2]!, additions: 0, deletions: 0 });
      i += 3;
    } else {
      changes.push({ status: s, path: status[i + 1]!, additions: 0, deletions: 0 });
      i += 2;
    }
  }
  // numstat -z: "<add>\t<del>\t<path>\0" or for renames "<add>\t<del>\t\0<old>\0<new>\0"
  const parts = numstat.split('\0');
  const counts = new Map<string, [number, number]>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(p);
    if (!m) continue;
    const add = m[1] === '-' ? 0 : Number(m[1]);
    const del = m[2] === '-' ? 0 : Number(m[2]);
    let path = m[3]!;
    if (path === '') {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    counts.set(path, [add, del]);
  }
  for (const c of changes) {
    const n = counts.get(c.path);
    if (n) [c.additions, c.deletions] = n;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface CurrentTurnInfo {
  pending?: PendingTurn;
  stateAfter?: string;
  headAfter?: string;
  endedAt?: string;
}

export interface CaptureInput {
  root: string;
  sessionId: string;
  transcriptPath: string;
  /** Repo-relative cwd of the agent. */
  cwd?: string;
  /** Info for the most recent turn (the one that just ended). Omit when importing/flushing. */
  current?: CurrentTurnInfo;
  sessionPatch?: Partial<SessionMeta>;
  redact?: Redactor;
  /** Extra files per turn, e.g. subagent transcripts: turn index -> { 'subagents/x.jsonl': content }. */
  extraFiles?: Map<number, Record<string, string>>;
}

export interface CaptureResult {
  commit: string;
  turnCount: number;
  currentTurn: number;
}

function blobEntry(root: string, name: string, content: string): TreeEntry {
  return { mode: '100644', type: 'blob', sha: hashBlob(root, content), name };
}

function readJsonAt<T>(root: string, rev: string): T | null {
  const [buf] = catFileBatch(root, [rev]);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return null;
  }
}

function commitsBetween(root: string, from: string | undefined, to: string | undefined): string[] {
  if (!to || from === to) return [];
  const range = from ? `${from}..${to}` : to;
  const out = gitMaybe(['rev-list', '--reverse', range], { cwd: root });
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * Write the session's current transcript into its ref. Idempotent: re-running rewrites the latest turns
 * (transcripts can flush late) and reuses everything older.
 */
export function captureSession(input: CaptureInput): CaptureResult | null {
  const { root, sessionId } = input;
  const redact = input.redact ?? ((s: string) => s);
  const raw = existsSync(input.transcriptPath) ? readFileSync(input.transcriptPath, 'utf8') : '';
  const lines = raw.split('\n').filter((l) => l.trim());
  const chunks = splitByTurn(lines);
  if (chunks.length === 0) return null;
  const N = chunks.length;

  const ref = sessionRef(sessionId);
  const prev = gitMaybe(['rev-parse', '--verify', '-q', ref], { cwd: root }) ?? undefined;
  const prevTurns = new Map<string, TreeEntry>();
  if (prev) for (const e of lsTree(root, `${prev}:turns`)) prevTurns.set(e.name, e);

  const normalized = normalize(lines).filter((t) => t.index > 0);
  const turnEntries: TreeEntry[] = [];

  for (let i = 1; i <= N; i++) {
    const name = turnDirName(i);
    const prevEntry = prevTurns.get(name);
    const rewrite = i >= N - 1 || !prevEntry;
    if (!rewrite && prevEntry) {
      turnEntries.push(prevEntry);
      continue;
    }
    const chunk = chunks[i - 1]!;
    const prevItems = prevEntry ? lsTree(root, prevEntry.sha) : [];
    const keep = new Map(prevItems.map((e) => [e.name, e]));
    let meta: TurnMeta = (prevEntry && readJsonAt<TurnMeta>(root, `${prevEntry.sha}:meta.json`)) || { schema: SCHEMA_VERSION, index: i, commits: [] };
    meta.index = i;
    meta.promptUuid = chunk.promptUuid ?? meta.promptUuid;
    meta.model = normalized[i - 1]?.model ?? meta.model;
    meta.startedAt = meta.startedAt ?? normalized[i - 1]?.timestamp;

    if (i === N && input.current) {
      const c = input.current;
      const p = c.pending;
      if (p) {
        meta.startedAt = p.startedAt;
        meta.headBefore = p.headBefore;
        meta.stateBefore = p.stateBefore;
        meta.branch = p.branch;
      }
      if (c.stateAfter) meta.stateAfter = c.stateAfter;
      if (c.headAfter) meta.headAfter = c.headAfter;
      meta.endedAt = c.endedAt ?? new Date().toISOString();
      meta.commits = commitsBetween(root, meta.headBefore, meta.headAfter);
      if (meta.stateBefore && meta.stateAfter) meta.filesChanged = diffTrees(root, meta.stateBefore, meta.stateAfter);
    }

    const items: TreeEntry[] = [];
    items.push(blobEntry(root, 'meta.json', JSON.stringify(meta, null, 2) + '\n'));
    items.push(blobEntry(root, 'transcript.jsonl', chunk.lines.map(redact).join('\n') + '\n'));
    if (meta.stateBefore) items.push({ mode: '040000', type: 'tree', sha: meta.stateBefore, name: 'before' });
    if (meta.stateAfter) items.push({ mode: '040000', type: 'tree', sha: meta.stateAfter, name: 'after' });

    const extra = input.extraFiles?.get(i);
    const subEntries: TreeEntry[] = [];
    if (extra) {
      for (const [path, content] of Object.entries(extra)) {
        const [dir, file] = path.split('/') as [string, string | undefined];
        if (dir === 'subagents' && file) subEntries.push(blobEntry(root, file, redact(content)));
      }
    } else if (keep.get('subagents')) {
      items.push(keep.get('subagents')!);
    }
    if (subEntries.length) items.push({ mode: '040000', type: 'tree', sha: mktree(root, subEntries), name: 'subagents' });
    turnEntries.push({ mode: '040000', type: 'tree', sha: mktree(root, items), name });
  }

  // session.json
  const facts = transcriptFacts(lines);
  const prevMeta = prev ? readJsonAt<SessionMeta>(root, `${prev}:session.json`) : null;
  const now = new Date().toISOString();
  const nameEmail = gitMaybe(['var', 'GIT_AUTHOR_IDENT'], { cwd: root });
  const author = nameEmail ? /^(.*) <(.*)> \d+ [+-]\d+$/.exec(nameEmail) : null;
  const meta: SessionMeta = {
    schema: SCHEMA_VERSION,
    sessionId,
    agent: 'claude-code',
    cwd: input.cwd ?? prevMeta?.cwd ?? '',
    startedAt: prevMeta?.startedAt ?? facts.startedAt ?? now,
    ...prevMeta,
    ...(facts.version ? { agentVersion: facts.version } : {}),
    ...(facts.title ? { title: facts.title } : prevMeta?.title ? {} : { title: normalized[0]?.prompt.split('\n')[0]?.slice(0, 80) }),
    ...(author ? { author: { name: author[1]!, email: author[2]! } } : {}),
    branch: currentBranch(root) ?? prevMeta?.branch ?? facts.branch,
    ...input.sessionPatch,
    updatedAt: now,
  };

  const rootTree = mktree(root, [
    blobEntry(root, 'session.json', JSON.stringify(meta, null, 2) + '\n'),
    { mode: '040000', type: 'tree', sha: mktree(root, turnEntries), name: 'turns' },
  ]);
  const prompt = normalized[N - 1]?.prompt.split('\n')[0]?.slice(0, 72) ?? '';
  const args = ['commit-tree', rootTree, '-m', `turn ${N}: ${prompt}`];
  if (prev) args.push('-p', prev);
  const commit = git(args, { cwd: root });
  git(['update-ref', ref, commit, ...(prev ? [prev] : [])], { cwd: root });
  return { commit, turnCount: N, currentTurn: N };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SessionRefInfo {
  sessionId: string;
  commit: string;
}

export function listSessions(cwd: string): SessionRefInfo[] {
  const out = gitMaybe(['for-each-ref', '--format=%(refname) %(objectname)', REF_PREFIX], { cwd });
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, commit] = l.split(' ') as [string, string];
      return { sessionId: ref.slice(REF_PREFIX.length), commit };
    });
}

export interface StoredTurn {
  meta: TurnMeta;
  transcript: string[];
  treeSha: string;
}

export interface StoredSession {
  commit: string;
  meta: SessionMeta;
  turns: StoredTurn[];
}

export function readStoredSession(cwd: string, sessionId: string, at?: string): StoredSession | null {
  const commit = at ?? gitMaybe(['rev-parse', '--verify', '-q', sessionRef(sessionId)], { cwd });
  if (!commit) return null;
  const turnDirs = lsTree(cwd, `${commit}:turns`).filter((e) => e.type === 'tree');
  const revs = [`${commit}:session.json`];
  for (const t of turnDirs) revs.push(`${t.sha}:meta.json`, `${t.sha}:transcript.jsonl`);
  const bufs = catFileBatch(cwd, revs);
  const meta = JSON.parse(bufs[0]?.toString('utf8') ?? '{}') as SessionMeta;
  const turns: StoredTurn[] = turnDirs.map((t, i) => ({
    treeSha: t.sha,
    meta: JSON.parse(bufs[1 + i * 2]?.toString('utf8') ?? '{}') as TurnMeta,
    transcript: (bufs[2 + i * 2]?.toString('utf8') ?? '').split('\n').filter((l) => l.trim()),
  }));
  return { commit, meta, turns };
}

/** Load a stored session as normalized turns with their TurnMeta attached. */
export function loadSession(cwd: string, sessionId: string): Session | null {
  const stored = readStoredSession(cwd, sessionId);
  if (!stored) return null;
  const turns = normalize(stored.turns.flatMap((t) => t.transcript)).filter((t) => t.index > 0);
  const metaByIndex = new Map(stored.turns.map((t) => [t.meta.index, t.meta]));
  for (const t of turns) {
    const m = metaByIndex.get(t.index);
    if (m) t.meta = m;
  }
  return { meta: stored.meta, turns };
}

/** Transcript lines up to and including turn `upTo` — the input for ask/fork. */
export function transcriptUpTo(stored: StoredSession, upTo: number): string[] {
  return stored.turns.filter((t) => t.meta.index <= upTo).flatMap((t) => t.transcript);
}

export function relCwd(root: string, cwd: string): string {
  const r = relative(root, cwd);
  return r.startsWith('..') ? '' : r;
}
