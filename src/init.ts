/**
 * init: drop the builder rulebooks into a project's reference/ folder with the placeholders filled.
 *   1to1 init <projectDir> [--ref reference/name] [--brand Name] [--routes /,/about] [--port 3777] [--stack "..."]
 * Writes <projectDir>/reference/CONVENTIONS.md, PAGES.md, GOAL.md (from templates/). Existing files are not
 * overwritten unless --force. No template carries the origin: the rebuild is named by --brand (default: the
 * project folder name), and the source url stays in reference/<name>/.origin.json, which init gitignores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from './lib/args.ts';
import { readOrigin, writeOrigin, brandFor } from './lib/anon.ts';

const TEMPLATES = path.resolve(import.meta.dir, '..', 'templates');
const IGNORE_LINE = 'reference/*/.origin.json';

export function runInit(argv: string[]) {
  const a = new Args(argv);
  const project = a.positional[0];
  if (!project) usage('usage: 1to1 init <projectDir> [--ref reference/name] [--brand Name] [--routes /,/about] [--port 3777] [--stack "..."] [--force]');
  const abs = path.resolve(project);
  const refDir = a.str('ref') ?? (() => {
    const r = path.join(abs, 'reference');
    const cands = fs.existsSync(r) ? fs.readdirSync(r).filter((d) => fs.existsSync(path.join(r, d, 'dom', 'full.html'))) : [];
    return cands.length ? path.join('reference', cands[0]) : 'reference/<name>';
  })();
  const refAbs = path.resolve(abs, refDir);
  const origin = readOrigin(refAbs);
  const brand = brandFor(abs, a.str('brand') ?? (origin?.brand !== 'brand' ? origin?.brand : undefined));
  if (origin && origin.brand !== brand) {
    writeOrigin(refAbs, { ...origin, brand });
    console.log(`brand for this rebuild: "${brand}" (was "${origin.brand}"). Re-run \`1to1 prep ${refDir}\` so the specs read the same.`);
  }
  const vars: Record<string, string> = {
    PROJECT: abs,
    BRAND: brand,
    REF: refDir,
    REF_ABS: refAbs,
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
  // the one file that names the origin never gets committed
  const gi = path.join(abs, '.gitignore');
  const body = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!body.split('\n').some((l) => l.trim() === IGNORE_LINE)) {
    fs.writeFileSync(gi, (body && !body.endsWith('\n') ? body + '\n' : body) + `\n# origin blackout: the source url stays local\n${IGNORE_LINE}\n`);
    console.log(`gitignored ${IGNORE_LINE}`);
  }
}
