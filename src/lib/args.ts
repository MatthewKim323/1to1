/** Tiny argv helper shared by every command. `--k v` options, `--flag` booleans, positionals. */
export class Args {
  readonly positional: string[] = [];
  private readonly opts = new Map<string, string | true>();

  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('--')) {
        const k = a.slice(2);
        const eq = k.indexOf('=');
        if (eq >= 0) {
          this.opts.set(k.slice(0, eq), k.slice(eq + 1));
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          this.opts.set(k, argv[++i]);
        } else {
          this.opts.set(k, true);
        }
      } else {
        this.positional.push(a);
      }
    }
  }

  str(k: string, d: string): string;
  str(k: string): string | undefined;
  str(k: string, d?: string) {
    const v = this.opts.get(k);
    if (v === undefined || v === true) return d;
    return v;
  }
  num(k: string, d: number) {
    const v = this.opts.get(k);
    if (v === undefined || v === true) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  flag(k: string) {
    return this.opts.has(k);
  }
  list(k: string): string[] {
    const v = this.str(k);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }
}

export function usage(text: string): never {
  console.error(text.trim());
  process.exit(1);
}
