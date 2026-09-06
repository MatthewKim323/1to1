#!/usr/bin/env bun
/**
 * 1to1: clone anything.
 *
 *   1to1 clone <url> [--out reference] [--name slug] [--headless] [--no-frames]   extract + capture + prep + rip + REBUILD.md
 *
 * stages
 *   extract <url>                 DOM, revealed full pages (4 widths), tokens, observed motion, assets, stack
 *   capture <url>                 layout.json + section crops per width, 60fps frame scenarios, assets, README
 *   prep <ref>                    spec/page.txt (+ per section), tree, styles, appear json, modules, svg defs
 *   rip <ref>                     Framer module motion windows + transition constants + appear-by-name
 *   brief <ref>                   (re)write REBUILD.md
 *   init <project> --url <url>    CONVENTIONS.md / PAGES.md / GOAL.md into <project>/reference/
 *
 * verify loop
 *   shot <url> <out.png>          revealed scroll-and-stitch screenshot (--w --clip --scrollto --click --hover)
 *   heights <url> [<url2>]        page + section heights at every width, side by side
 *   boxes <url> <w> <y0> <y1>     element boxes of a live page
 *   refboxes <ref> <vp> <y0> <y1> element boxes from the reference layout.json
 *   diff <build.png> <ref.png> <outDir> [--ref <ref>]   per-section pixel diff with side-by-side sheets
 *   frames <url> <outDir>         screencast your build (load / click / hover / scroll scenarios)
 *   sheet <framesDir> <out.png>   contact sheet at fixed time steps
 *   console <base> [/a,/b]        console errors while scrolling routes
 *   cms <url> <out.json>          scrape a CMS listing (tabs + Load More)
 *   cssq <ref> <class...>         CSS rules per breakpoint for classes
 *   verify <buildUrl> <ref>       THE GATE: heights + sections + console (+ --diff) at every width, PASS / FAIL
 */
import path from 'node:path';
import fs from 'node:fs';
import { Args, usage } from './lib/args.ts';

const [cmd, ...rest] = process.argv.slice(2);

const HELP = fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith(' *')).map((l) => l.replace(/^ \*\s?/, '')).join('\n');

async function main() {
  switch (cmd) {
    case 'clone': return clone(rest);
    case 'extract': return (await import('./extract.ts')).runExtract(rest);
    case 'capture': return (await import('./capture.ts')).runCapture(rest);
    case 'prep': return (await import('./prep.ts')).runPrep(rest);
    case 'rip': return (await import('./rip.ts')).runRip(rest);
    case 'brief': return (await import('./brief.ts')).runBrief(rest);
    case 'init': return (await import('./init.ts')).runInit(rest);
    case 'shot': return (await import('./rig/shot.ts')).runShot(rest);
    case 'heights': return (await import('./rig/measure.ts')).runHeights(rest);
    case 'sections': return (await import('./rig/measure.ts')).runHeights(rest);
    case 'boxes': return (await import('./rig/measure.ts')).runBoxes(rest);
    case 'refboxes': return (await import('./rig/measure.ts')).runRefboxes(rest);
    case 'diff': return (await import('./rig/diff.ts')).runDiff(rest);
    case 'frames': return (await import('./rig/frames.ts')).runFrames(rest);
    case 'sheet': return (await import('./rig/frames.ts')).runSheet(rest);
    case 'console': return (await import('./rig/misc.ts')).runConsole(rest);
    case 'cms': return (await import('./rig/misc.ts')).runCms(rest);
    case 'cssq': return (await import('./rig/misc.ts')).runCssq(rest);
    case 'verify': return (await import('./rig/verify.ts')).runVerify(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      usage(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

async function clone(argv: string[]) {
  const a = new Args(argv);
  const url = a.positional[0];
  if (!url) usage('usage: 1to1 clone <url> [--out reference] [--name slug] [--headless] [--no-frames] [--viewports 1440,1024,810,390]');
  const { runExtract, slugFromUrl } = await import('./extract.ts');
  const name = a.str('name') ?? slugFromUrl(url);
  const pass = (...ks: string[]) => ks.flatMap((k) => (a.str(k) ? [`--${k}`, a.str(k)!] : []));
  const { outDir } = await runExtract([url, ...pass('out', 'name', 'viewports'), ...(a.flag('headless') ? ['--headless'] : [])]);
  const { runCapture } = await import('./capture.ts');
  await runCapture([url, '--name', name, ...pass('out', 'viewports', 'max-hovers', 'hovers'), ...(a.flag('no-frames') ? ['--only', 'static'] : [])]);
  const { runPrep } = await import('./prep.ts');
  await runPrep([outDir]);
  const { runRip } = await import('./rip.ts');
  if (fs.existsSync(path.join(outDir, 'modules')) && fs.readdirSync(path.join(outDir, 'modules')).length) await runRip([outDir]);
  const { writeBrief } = await import('./brief.ts');
  const brief = writeBrief(outDir);
  console.log(`\nclone complete -> ${outDir}\nread ${brief}`);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
