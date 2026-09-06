/**
 * init: drop the builder rulebooks into a project's reference/ folder with the placeholders filled.
 *   1to1 init <projectDir> --url <live url> [--ref reference/name] [--routes /,/about] [--port 3777] [--stack "..."]
 * Writes <projectDir>/reference/CONVENTIONS.md, PAGES.md, GOAL.md (from templates/). Existing files are not overwritten unless --force.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from './lib/args.ts';

const TEMPLATES = path.resolve(import.meta.dir, '..', 'templates');

export function runInit(argv: string[]) {
  const a = new Args(argv);
  const project = a.positional[0];
  const url = a.str('url');
  if (!project || !url) usage('usage: 1to1 init <projectDir> --url <live url> [--ref reference/name] [--routes /,/about] [--port 3777] [--stack "..."] [--force]');
  const abs = path.resolve(project);
  const refDir = a.str('ref') ?? (() => {
    const r = path.join(abs, 'reference');
    const cands = fs.existsSync(r) ? fs.readdirSync(r).filter((d) => fs.existsSync(path.join(r, d, 'dom', 'full.html'))) : [];
    return cands.length ? path.join('reference', cands[0]) : 'reference/<name>';
  })();
  const vars: Record<string, string> = {
    PROJECT: abs,
    URL: url,
    REF: refDir,
    REF_ABS: path.resolve(abs, refDir),
    PORT: String(a.num('port', 3777)),
    STACK: a.str('stack', 'Next.js (App Router) + React 19 + `motion` (import from "motion/react") + Lenis'),
    ROUTES: a.str('routes', '/'),
    DATE: new Date().toISOString().slice(0, 10),
  };
  fs.mkdirSync(path.join(abs, 'reference'), { recursive: true });
  for (const f of ['CONVENTIONS.md', 'PAGES.md', 'GOAL.md']) {
    const dst = path.join(abs, 'reference', f);
    if (fs.existsSync(dst) && !a.flag('force')) { console.log(`keep ${dst} (exists; --force to overwrite)`); continue; }
    let s = fs.readFileSync(path.join(TEMPLATES, f), 'utf8');
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{{${k}}}`, v);
    fs.writeFileSync(dst, s);
    console.log(`wrote ${dst}`);
  }
}
