/**
 * REBUILD.md for a reference dir: what was captured, the section table with y-ranges per viewport, and the
 * exact commands for the build loop. Written by `1to1 clone` and `1to1 brief <reference/name>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from './lib/args.ts';
import { readOrigin } from './lib/anon.ts';

export function writeBrief(root: string) {
  const meta = fs.existsSync(path.join(root, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8')) : {};
  const rep = fs.existsSync(path.join(root, 'capture', 'report.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'capture', 'report.json'), 'utf8')).report : null;
  const rel = path.relative(process.cwd(), root) || '.';
  const name = path.basename(root);
  const L: string[] = [];
  const origin = readOrigin(root);
  const brand = origin?.brand ?? meta.brand ?? 'brand';
  L.push(`# REBUILD: ${name}`, '', `> Captured ${meta.capturedAt ?? '?'} by 1to1. Everything in this folder is measured from a live page. Build from it; never eyeball a number.`, '');
  L.push('## Origin blackout (not optional)', '');
  L.push(`Nothing you write may say where this came from. The source url lives in \`${rel}/.origin.json\` and nowhere else: it is there so the rigs can re-measure, not for you to read out. These are your own components and your own assets.`, '');
  L.push(`- Never put the origin's name, host, brand, logo filename or a link to it in a component, file name, class name, comment, commit message, alt text or doc. Do not write "cloned from", "based on", "like <site>", or the origin's name in any form.`);
  L.push(`- The spec trees, the modules and the harvested assets in this folder are already scrubbed: the origin's words read as \`${brand}\` and its links are route-relative. Copy text verbatim from \`spec/\` and you stay clean; copy it from a browser tab and you do not.`);
  L.push(`- Assets are content addressed (\`img-<hash>.webp\`, \`font-<hash>.woff2\`). Keep those names when you copy them into \`public/\`. A logo or wordmark asset still carries the origin visually: flag it for replacement rather than shipping it.`);
  L.push(`- \`1to1 blackout .\` scans the project for anything that slipped through; \`1to1 verify\` runs it as part of the gate and FAILs on a hit.`, '');
  L.push('## Ground truth in this folder', '');
  L.push(`- \`spec/page.txt\`: DOM tree (framer names, appear ids, classes, layout inline styles, text) + every CSS rule for those classes per breakpoint (\`@base\` = desktop >= 1200, \`(min-width:810px) and (max-width:1199.98px)\` = tablet, \`(max-width:809.98px)\` = phone). \`spec/sections/NN-*.txt\` = the same sliced per section.`);
  L.push(`- \`capture/<vp>/layout.json\`: every visible element with its page rect and computed styles at 1440 / 1024 / 810 / 390. This is the box truth; \`1to1 refboxes\` reads it.`);
  L.push(`- \`capture/<vp>/full.png\` + \`capture/<vp>/sections/\`: revealed screenshots (2x). \`capture/frames/<scenario>/\`: 60fps frame sequences (load, per-section scroll, hovers, clicks, loops) with motion timelines.`);
  L.push(`- \`motion/framer-appear.json\` (+ \`appear-by-name.json\`): on-mount appear springs per element. \`motion/rip.md\` + \`constants.json\`: transition constants and scroll / text / ticker / drag effect windows from the page modules. \`motion/observed.md\`: what the browser reported.`);
  L.push(`- \`modules/*.mjs\`: the source page's modules, scrubbed. The biggest one is the page. \`assets/\`, \`assets/svg/\`: every image / font / sprite def.`);
  L.push(`- \`dom/full.html\`, \`dom/styles.css\`, \`dom/tree.txt\`: raw material for \`1to1 cssq\` and grep.`, '');
  if (meta.stack) L.push(`Stack: ${meta.stack.framework}${meta.stack.framer ? ' (Framer)' : ''}${meta.stack.lenis ? ' + Lenis' : ''}${meta.stack.gsap ? ' + GSAP' : ''}. ${(meta.stack.notes || []).join(' ')}`, '');
  if (rep) {
    L.push('## Page heights (must match to the pixel)', '', '| viewport | width | doc height | sections |', '|---|---|---|---|');
    for (const [n, v] of Object.entries<any>(rep.viewports)) L.push(`| ${n} | ${v.width} | ${v.docHeight} | ${(rep.sections?.[n] || []).length} |`);
    L.push('');
    for (const [vp, secs] of Object.entries<any>(rep.sections || {})) {
      L.push(`### sections @ ${vp}`, '', '| # | name | y | h | spec | crop |', '|---|---|---|---|---|---|');
      for (const s of secs) L.push(`| ${s.index} | ${s.name} | ${s.y} | ${s.h} | spec/sections/${String(s.index).padStart(2, '0')}-${s.slug}.txt | capture/${vp}/sections/${String(s.index).padStart(2, '0')}-${s.slug}.png |`);
      L.push('');
    }
    const scen = Object.keys(rep.scenarios || {});
    if (scen.length) L.push(`Frame scenarios (${scen.length}): ${scen.join(', ')}. Details in \`capture/README.md\`.`, '');
  }
  L.push('## The loop', '', '```bash');
  L.push(`# build one section, then compare`);
  L.push(`1to1 shot "http://localhost:3777/?only=<section>" ${rel}/build/<section>.png --w 1440`);
  L.push(`1to1 heights http://localhost:3777/ "$(1to1 origin ${rel} --url)"          # page + section heights at all 4 widths`);
  L.push(`1to1 boxes http://localhost:3777/ 1440 <yFrom> <yTo>                       # your boxes`);
  L.push(`1to1 refboxes ${rel} desktop <yFrom> <yTo>                                # reference boxes (same columns)`);
  L.push(`1to1 diff ${rel}/build/desktop-full.png ${rel}/capture/desktop/full.png ${rel}/build/diff --ref ${rel}`);
  L.push(`1to1 frames http://localhost:3777/ ${rel}/build/frames/load --ms 6000 --start-before-nav && 1to1 sheet ${rel}/build/frames/load ${rel}/build/load-sheet.png`);
  L.push(`1to1 sheet ${rel}/capture/frames/load ${rel}/build/ref-load-sheet.png    # same time steps, compare side by side`);
  L.push(`1to1 verify http://localhost:3777/ ${rel} --diff                          # the gate: PASS at every width or keep going`);
  L.push(`1to1 blackout .                                                            # no mention of the origin anywhere in the project`);
  L.push('```', '', 'Rules for builders are in `CONVENTIONS.md` (project root `reference/`), method in the 1to1 skill docs (`docs/METHOD.md`, `docs/FRAMER.md`, `docs/VERIFY.md`).', '');
  fs.writeFileSync(path.join(root, 'REBUILD.md'), L.join('\n'));
  return path.join(root, 'REBUILD.md');
}

export function runBrief(argv: string[]) {
  const a = new Args(argv);
  const root = a.positional[0];
  if (!root || !fs.existsSync(root)) usage('usage: 1to1 brief <reference/name>');
  console.log('wrote', writeBrief(path.resolve(root)));
}
