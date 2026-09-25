import { assembleReview, parseRange } from '../../core/review.ts';
import { formatTurn } from './show.ts';

export async function run(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const { base, head } = parseRange(cwd, args.find((a) => !a.startsWith('-')));
  const r = assembleReview(cwd, base, head);
  process.stdout.write(`review ${base}..${head}: ${r.commits.length} commits, ${r.slices.length} conversation slice(s)\n\n`);
  for (const c of r.commits) process.stdout.write(`  ${c.sha.slice(0, 8)} ${c.subject}\n`);
  for (const sl of r.slices) {
    const s = r.sessions[sl.sessionId]!;
    process.stdout.write(`\n=== session ${sl.sessionId.slice(0, 8)} "${s.meta.title ?? ''}" turns ${sl.fromTurn}-${sl.toTurn}\n\n`);
    for (const t of s.turns.filter((t) => t.index >= sl.fromTurn && t.index <= sl.toTurn)) process.stdout.write(formatTurn(t) + '\n\n');
  }
  return 0;
}
