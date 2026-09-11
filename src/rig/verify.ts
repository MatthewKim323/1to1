/**
 * verify: the 1:1 gate. Measures a build route against its reference at every viewport and says PASS / FAIL.
 *   1to1 verify <buildUrl> <reference/name> [--w 1440,1024,810,390] [--tolerance 0] [--diff] [--out reference/name/build]
 * Checks, per viewport:
 *   1. page height   build == reference capture docHeight (tolerance px)
 *   2. section heights  every reference section has a build block starting at the same y (3px) with the same height; unmatched = warned
 *   3. --diff: stitched full-page pixel diff per section vs capture/<vp>/full.png (informational; text AA and mid-spring
 *      captures make a nonzero % normal, so it is reported but does not fail the gate)
 *   4. console: zero errors / page errors while scrolling the build
 *   5. origin blackout: nothing in the project names the source (`1to1 blackout`); --no-blackout skips it
 * Writes <out>/verify.json and prints a table. Exit code 1 on FAIL. This is what the /goal condition should point at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from '../lib/args.ts';
import { launch, newCtx, load, reveal, measureSections, stitchFullPage, viewportByWidth, VIEWPORTS, log } from '../lib/browser.ts';
import { runDiff } from './diff.ts';
import { runBlackout } from './blackout.ts';

export async function runVerify(argv: string[]) {
  const a = new Args(argv);
  const [url, ref] = a.positional;
  if (!url || !ref) usage('usage: 1to1 verify <buildUrl> <reference/name> [--w 1440,1024,810,390] [--tolerance 0] [--diff] [--out dir] [--project .] [--no-blackout]');
  const reportFile = path.join(ref, 'capture', 'report.json');
  if (!fs.existsSync(reportFile)) usage(`no ${reportFile}. run: 1to1 capture <url> --only static`);
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')).report;
  const widths = a.list('w').map(Number);
  const ws = widths.length ? widths : VIEWPORTS.map((v) => v.width).filter((w) => rep.viewports?.[viewportByWidth(w).name]);
  const tol = a.num('tolerance', 0);
  const outDir = a.str('out', path.join(ref, 'build'));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(true);
  const result: any = { url, ref, at: new Date().toISOString(), viewports: {}, pass: true };
  for (const w of ws) {
    const vp = viewportByWidth(w);
    const refVp = rep.viewports?.[vp.name];
    const refSecs: any[] = rep.sections?.[vp.name] ?? [];
    if (!refVp) { log(`no reference capture for ${vp.name}`); continue; }
    const ctx = await newCtx(browser, vp, 2);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 160)));
    await load(page, url, a.num('wait', 2500));
    await reveal(page);
    const m = await measureSections(page);
    const heightOk = Math.abs(m.docHeight - refVp.docHeight) <= tol;
    // match by position: a block that starts within 3px of the reference section's y is the same block, whatever the tag structure
    const secRows = refSecs.map((s) => { const b = m.sections.find((x) => Math.abs(x.y - s.y) <= 3); return { name: s.name, y: s.y, ref: s.h, build: b?.h ?? null, delta: b ? b.h - s.h : null, ok: b ? Math.abs(b.h - s.h) <= tol : null }; });
    const secOk = secRows.every((r) => r.ok !== false);
    const unmatched = secRows.filter((r) => r.ok === null);
    let diff: any = null;
    if (a.flag('diff')) {
      const buildPng = path.join(outDir, `${vp.name}-full.png`);
      await stitchFullPage(page, vp.width, vp.height, buildPng, 2, { chunkWaitMs: 1300, wheelNudge: true });
      const refPng = path.join(ref, 'capture', vp.name, 'full.png');
      const ddir = path.join(outDir, 'diff', vp.name);
      await runDiff([buildPng, refPng, ddir, '--ref', ref, '--vp', vp.name]);
      diff = JSON.parse(fs.readFileSync(path.join(ddir, 'diff.json'), 'utf8'));
    }
    const uniqErrors = [...new Set(errors)].filter((e) => !e.includes('GPU stall'));
    const vpPass = heightOk && secOk && uniqErrors.length === 0;
    result.viewports[vp.name] = { width: vp.width, docHeight: { ref: refVp.docHeight, build: m.docHeight, ok: heightOk }, sections: secRows, consoleErrors: uniqErrors, diff, pass: vpPass };
    result.pass &&= vpPass;
    console.log(`\n== ${vp.name} ${vp.width}px  ${vpPass ? 'PASS' : 'FAIL'}`);
    console.log(`page height  ref ${refVp.docHeight}  build ${m.docHeight}  ${heightOk ? 'ok' : `DELTA ${m.docHeight - refVp.docHeight}`}`);
    for (const r of secRows) console.log(`  ${r.ok === false ? '!' : r.ok === null ? '?' : ' '} y=${String(r.y).padStart(5)} ${String(r.ref).padStart(6)} ${String(r.build ?? '-').padStart(6)} ${r.delta === null ? '' : (r.delta >= 0 ? '+' : '') + r.delta}`.padEnd(36) + r.name);
    if (unmatched.length) console.log(`  ? ${unmatched.length} reference block(s) have no top-level block starting at the same y in the build (height not checked)`);
    if (uniqErrors.length) console.log(`  console errors: ${uniqErrors.length}\n    ${uniqErrors.slice(0, 5).join('\n    ')}`);
    if (diff) console.log(`  pixel diff: ${diff.map((d: any) => `${d.name} ${(d.differ * 100).toFixed(1)}%`).join(', ')}`);
    await ctx.close();
  }
  await browser.close();
  if (!a.flag('no-blackout')) {
    console.log('\n== origin blackout');
    const clean = runBlackout([a.str('project', process.cwd()), '--ref', path.resolve(ref)]);
    result.blackout = clean;
    result.pass &&= clean;
    process.exitCode = undefined;   // the gate below owns the exit code
  }
  fs.writeFileSync(path.join(outDir, 'verify.json'), JSON.stringify(result, null, 1));
  console.log(`\n${result.pass ? 'PASS' : 'FAIL'} -> ${path.join(outDir, 'verify.json')}`);
  if (!result.pass) process.exitCode = 1;
}
