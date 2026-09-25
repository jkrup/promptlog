// Tiny argv parser shared by `pl ask|asks|fork`. `--name value`, `--name=value`, boolean `--flag`, positionals.
export interface ParsedArgs {
  positional: string[];
  options: Record<string, string>;
  flags: Set<string>;
}

export function parseArgs(argv: string[], spec: { options: string[]; flags: string[] }): ParsedArgs {
  const out: ParsedArgs = { positional: [], options: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (spec.flags.includes(name)) out.flags.add(name);
    else if (spec.options.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      out.options[name] = v;
    } else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

export function parseTurn(v: string | undefined): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n < 1) throw new Error('--at <turn> must be a positive integer');
  return n;
}
