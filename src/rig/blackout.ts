/**
 * blackout: the origin gate. Walks a project and fails if anything still says where the rebuild came from.
 *   1to1 blackout <projectDir> [--ref reference/name] [--tokens a,b] [--strict] [--fix]
 * A hit in a path, an import, a url, a comment or an identifier is a LEAK and exits 1. A hit that reads as
 * display copy is reported as `copy` so it gets rewritten deliberately (`--strict` fails on those too,
 * `--fix` rewrites every hit in place to the project's brand). `1to1 verify` runs this as part of the gate.
 *
 * origin: print what is being cloned, for scripting rigs without repeating the url in prose.
 *   1to1 origin <reference/name> [--url | --host | --tokens | --brand]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from '../lib/args.ts';
import { readOrigin, tokensFor, scanLeaks, printLeaks, scrub, brandFor } from '../lib/anon.ts';

/** Find the reference dirs of a project: <project>/reference/<name>/.origin.json */
export function referenceDirs(projectDir: string): string[] {
  const root = path.join(projectDir, 'reference');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && readOrigin(path.join(root, d.name)))
    .map((d) => path.join(root, d.name));
}

/** Tokens for every origin cloned into a project, plus anything passed on the command line. */
export function projectTokens(projectDir: string, extra: string[] = []) {
  const dirs = referenceDirs(projectDir);
  const tokens = new Set<string>();
  let brand = brandFor(projectDir);
  for (const d of dirs) {
    const t = tokensFor(d);
    for (const x of t.tokens) tokens.add(x);
    if (t.brand && t.brand !== 'brand') brand = t.brand;
  }
  for (const e of extra) tokens.add(e.toLowerCase());
  return { tokens: [...tokens].sort((a, b) => b.length - a.length), brand, refs: dirs };
}

export function runBlackout(argv: string[]) {
  const a = new Args(argv);
  const project = path.resolve(a.positional[0] ?? '.');
  if (!fs.existsSync(project)) usage('usage: 1to1 blackout <projectDir> [--ref reference/name] [--tokens a,b] [--strict] [--fix]');
  const explicitRef = a.str('ref');
  const { tokens, brand } = explicitRef ? tokensFor(path.resolve(project, explicitRef), a.list('tokens')) : projectTokens(project, a.list('tokens'));
  if (!tokens.length) {
    console.log('blackout: no origin tokens known (no reference/<name>/.origin.json, no --tokens). Nothing to check.');
    return true;
  }
  console.log(`blackout ${project}\n  tokens: ${tokens.join(', ')}  ->  "${brand}"`);
  const leaks = scanLeaks(project, tokens, { strict: a.flag('strict') });
  if (a.flag('fix')) {
    const files = [...new Set(leaks.filter((l) => l.line > 0).map((l) => l.file))];
    for (const f of files) {
      const full = path.join(project, f);
      fs.writeFileSync(full, scrub(fs.readFileSync(full, 'utf8'), tokens, brand));
    }
    const renames = leaks.filter((l) => l.line === 0);
    console.log(`  rewrote ${files.length} file(s) to "${brand}"${renames.length ? `; rename by hand: ${renames.map((r) => r.file).join(', ')}` : ''}`);
    return runBlackout([project, ...(explicitRef ? ['--ref', explicitRef] : []), ...(a.flag('strict') ? ['--strict'] : []), ...(a.list('tokens').length ? ['--tokens', a.list('tokens').join(',')] : [])]);
  }
  const { leaks: hard, copy } = printLeaks(leaks);
  const pass = hard === 0;
  console.log(`\n${pass ? 'CLEAN' : 'FAIL'}: ${hard} leak(s)${copy ? `, ${copy} copy mention(s) to rewrite` : ''}`);
  if (!pass) {
    console.log('Rename the file / identifier, drop the comment, or point the link somewhere of your own. `--fix` rewrites text hits to the project brand.');
    process.exitCode = 1;
  }
  return pass;
}

export function runOrigin(argv: string[]) {
  const a = new Args(argv);
  const ref = a.positional[0];
  if (!ref) usage('usage: 1to1 origin <reference/name> [--url|--host|--tokens|--brand]');
  const o = readOrigin(path.resolve(ref));
  if (!o) usage(`no .origin.json in ${ref}`);
  if (a.flag('url')) return console.log(o.url);
  if (a.flag('host')) return console.log(o.host);
  if (a.flag('tokens')) return console.log(tokensFor(path.resolve(ref)).tokens.join(','));   // re-derived, same list the scanner uses
  if (a.flag('brand')) return console.log(o.brand);
  console.log(JSON.stringify(o, null, 2));
}
