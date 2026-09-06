/**
 * Per-section pixel diff of two full-page PNGs (same width, both 2x by default): build vs reference.
 * Writes <outDir>/<section>.png side-by-side (build | reference | diff mask) and prints % pixels differing.
 * Section ranges come from the reference capture report (desktop by default) or --ranges JSON.
 * usage: 1to1 diff <build.png> <ref.png> <outDir> [--ref reference/name --vp desktop] [--ranges '[["hero",0,884],...]'] [--scale 2] [--threshold 40]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Args, usage } from '../lib/args.ts';

export async function runDiff(argv: string[]) {
  const a = new Args(argv);
  const [buildFile, refFile, outDir] = a.positional;
  if (!buildFile || !refFile || !outDir) usage("usage: 1to1 diff <build.png> <ref.png> <outDir> [--ref reference/name --vp desktop] [--ranges json] [--scale 2] [--threshold 40]");
  fs.mkdirSync(outDir, { recursive: true });
  const S = a.num('scale', 2), TH = a.num('threshold', 40);
  let ranges: [string, number, number][] | null = a.str('ranges') ? JSON.parse(a.str('ranges')!) : null;
  if (!ranges && a.str('ref')) {
    const rep = JSON.parse(fs.readFileSync(path.join(a.str('ref')!, 'capture', 'report.json'), 'utf8')).report;
    const secs = rep.sections?.[a.str('vp', 'desktop')] as any[] | undefined;
    if (secs) ranges = secs.map((s, i) => [`${String(i).padStart(2, '0')}-${s.slug}`, s.y, s.y + s.h]);
  }
  const B = sharp(buildFile), R = sharp(refFile);
  const bm = await B.metadata(), rm = await R.metadata();
  console.log(`build ${bm.width}x${bm.height}  ref ${rm.width}x${rm.height}  (2x: ${bm.height! / S} vs ${rm.height! / S} css px)`);
  if (!ranges) ranges = [['page', 0, Math.min(bm.height!, rm.height!) / S]];
  const W = Math.min(bm.width!, rm.width!);
  const results: { name: string; differ: number }[] = [];
  for (const [name, y0, y1] of ranges) {
    const top = Math.round(y0 * S), h = Math.round((y1 - y0) * S);
    if (top + h > bm.height! || top + h > rm.height!) { console.log(`${name}: out of range (build h ${bm.height! / S}, ref h ${rm.height! / S})`); continue; }
    const [bRaw, rRaw] = await Promise.all([sharp(buildFile).extract({ left: 0, top, width: W, height: h }).removeAlpha().raw().toBuffer(), sharp(refFile).extract({ left: 0, top, width: W, height: h }).removeAlpha().raw().toBuffer()]);
    const mask = Buffer.alloc(W * h);
    let n = 0;
    for (let i = 0, p = 0; i < bRaw.length; i += 3, p++) {
      const d = Math.max(Math.abs(bRaw[i] - rRaw[i]), Math.abs(bRaw[i + 1] - rRaw[i + 1]), Math.abs(bRaw[i + 2] - rRaw[i + 2]));
      if (d > TH) { mask[p] = 255; n++; }
    }
    const frac = n / (W * h);
    results.push({ name, differ: frac });
    const gap = 20;
    const maskPng = await sharp(mask, { raw: { width: W, height: h, channels: 1 } }).png().toBuffer();
    // sharp applies resize before composite inside one pipeline, so composite first, then downscale in a second pass
    const sheet = await sharp({ create: { width: W * 3 + gap * 2, height: h, channels: 3, background: '#ff00ff' } })
      .composite([
        { input: await sharp(buildFile).extract({ left: 0, top, width: W, height: h }).png().toBuffer(), left: 0, top: 0 },
        { input: await sharp(refFile).extract({ left: 0, top, width: W, height: h }).png().toBuffer(), left: W + gap, top: 0 },
        { input: maskPng, left: 2 * W + 2 * gap, top: 0 },
      ])
      .png()
      .toBuffer();
    await sharp(sheet).resize({ width: Math.round((W * 3 + gap * 2) / S) }).png().toFile(path.join(outDir, `${name}.png`));
    console.log(`${name}: ${(frac * 100).toFixed(2)}% pixels differ  (${y0}-${y1})`);
  }
  fs.writeFileSync(path.join(outDir, 'diff.json'), JSON.stringify(results, null, 1));
}
