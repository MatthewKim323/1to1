/**
 * frames: screencast YOUR build the same way the capture recorded the reference, so timelines line up.
 *   1to1 frames <url> <outDir> [--ms 4000] [--w 1440] [--h 900] [--click selector] [--scroll from,to,durMs] [--hover selector] [--start-before-nav]
 *   load timing:      1to1 frames http://localhost:3777/ out/load --ms 6000 --start-before-nav
 *   menu open:        1to1 frames http://localhost:3777/ out/menu --w 390 --h 844 --click '[aria-label="Open menu"]'
 *   scroll reveal:    1to1 frames http://localhost:3777/ out/scroll-benefits --scroll 119,749,1500
 * Output: NNNNN.png + frames.json ({i,t}) + motion-timeline.json (same method as capture).
 *
 * sheet: contact sheet of a frames dir (reference or build) at fixed time steps so two runs can be compared visually.
 *   1to1 sheet <framesDir> <out.png> [--step 250] [--count 12] [--width 200] [--from 0]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Args, usage } from '../lib/args.ts';
import { launch, newCtx, load, reveal, log } from '../lib/browser.ts';

export async function runFrames(argv: string[]) {
  const a = new Args(argv);
  const [url, outDir] = a.positional;
  if (!url || !outDir) usage("usage: 1to1 frames <url> <outDir> [--ms 4000] [--w 1440] [--h 900] [--click sel] [--hover sel] [--scroll from,to,dur] [--start-before-nav] [--dsf 1]");
  const MS = a.num('ms', 4000), W = a.num('w', 1440), H = a.num('h', W < 600 ? 844 : 900), DSF = a.num('dsf', 1);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/\.(png|json)$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  const browser = await launch(true);
  const ctx = await newCtx(browser, { width: W, height: H }, DSF);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames: { i: number; t: number; file: string; ts: number }[] = [];
  const writes: Promise<void>[] = [];
  let t0 = 0;
  cdp.on('Page.screencastFrame', (ev: any) => {
    const i = frames.length;
    const file = `${String(i).padStart(5, '0')}.png`;
    frames.push({ i, t: Math.round((ev.metadata.timestamp - t0) * 1000), file, ts: ev.metadata.timestamp });
    writes.push(fs.promises.writeFile(path.join(outDir, file), Buffer.from(ev.data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });
  const start = async () => { t0 = Date.now() / 1000; await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: W * DSF, maxHeight: H * DSF }); };

  const marks: Record<string, number> = {};
  if (a.flag('start-before-nav')) {
    await start();
    page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(MS);
  } else {
    await load(page, url, a.num('wait', 2500));
    if (a.flag('reveal')) await reveal(page);
    const scroll = a.list('scroll').map(Number);
    if (scroll.length === 3) {
      await page.evaluate((y) => window.scrollTo(0, y), scroll[0]);
      await page.waitForTimeout(400);
    }
    await start();
    await page.waitForTimeout(300);
    const click = a.str('click');
    const hover = a.str('hover');
    if (click) { marks.click = frames.at(-1)?.t ?? 0; await page.locator(click).first().click(); }
    if (hover) { marks.hoverStart = frames.at(-1)?.t ?? 0; const bb = await page.locator(hover).first().boundingBox(); if (bb) await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 10 }); marks.hoverEnd = frames.at(-1)?.t ?? 0; }
    if (scroll.length === 3) {
      marks.scrollStart = frames.at(-1)?.t ?? 0;
      await page.evaluate(({ from, to, dur }) => {
        const t0 = performance.now();
        const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
        const step = () => { const p = Math.min(1, (performance.now() - t0) / dur); window.scrollTo(0, from + (to - from) * ease(p)); if (p < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      }, { from: scroll[0], to: scroll[1], dur: scroll[2] });
    }
    await page.waitForTimeout(MS);
  }
  await cdp.send('Page.stopScreencast').catch(() => {});
  await Promise.all(writes);
  const sorted = [...frames].sort((x, y) => x.ts - y.ts);
  for (const f of sorted) fs.renameSync(path.join(outDir, f.file), path.join(outDir, 'tmp-' + f.file));
  sorted.forEach((f, i) => { const nf = `${String(i).padStart(5, '0')}.png`; fs.renameSync(path.join(outDir, 'tmp-' + f.file), path.join(outDir, nf)); f.file = nf; f.i = i; });
  fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify({ url, frameCount: sorted.length, ms: MS, marksMs: marks, frames: sorted.map(({ i, t, file }) => ({ i, t, file })) }, null, 1));
  // motion timeline (full frame)
  let prev: Buffer | null = null;
  const rows: any[] = [];
  for (const f of sorted) {
    const raw = await sharp(path.join(outDir, f.file)).resize({ width: 480 }).removeAlpha().raw().toBuffer();
    let changed = 0;
    if (prev && prev.length === raw.length) { let n = 0; for (let k = 0; k < raw.length; k += 3) if (Math.abs(raw[k] - prev[k]) > 20 || Math.abs(raw[k + 1] - prev[k + 1]) > 20 || Math.abs(raw[k + 2] - prev[k + 2]) > 20) n++; changed = n / (raw.length / 3); }
    prev = raw;
    rows.push({ i: f.i, t: f.t, changed: +changed.toFixed(5), motion: f.i > 0 && changed > 0.0003 });
  }
  const mrows = rows.filter((r) => r.motion);
  fs.writeFileSync(path.join(outDir, 'motion-timeline.json'), JSON.stringify({ summary: { firstMotionMs: mrows[0]?.t ?? null, lastMotionMs: mrows.at(-1)?.t ?? null, motionFrames: mrows.length, totalFrames: rows.length }, frames: rows }, null, 1));
  log(`captured ${sorted.length} frames over ${MS}ms -> ${outDir}; motion ${mrows[0]?.t ?? '-'}->${mrows.at(-1)?.t ?? '-'}ms`);
  await browser.close();
}

export async function runSheet(argv: string[]) {
  const a = new Args(argv);
  const [dir, out] = a.positional;
  if (!dir || !out) usage('usage: 1to1 sheet <framesDir> <out.png> [--step 250] [--count 12] [--width 200] [--from 0]');
  const fj = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  const frames: { t: number; file: string }[] = fj.frames;
  const step = a.num('step', 250), count = a.num('count', 12), width = a.num('width', 200), from = a.num('from', 0);
  const picks: { t: number; file: string; want: number }[] = [];
  for (let k = 0; k < count; k++) {
    const want = from + k * step;
    const f = [...frames].reverse().find((x) => x.t <= want) ?? frames[0];
    if (f) picks.push({ ...f, want });
  }
  const first = await sharp(path.join(dir, picks[0].file)).metadata();
  const h = Math.round((first.height! / first.width!) * width);
  const label = 18;
  const comps: sharp.OverlayOptions[] = [];
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    comps.push({ input: await sharp(path.join(dir, p.file)).resize({ width }).png().toBuffer(), left: i * (width + 4), top: label });
    const svg = `<svg width="${width}" height="${label}"><text x="2" y="13" font-family="monospace" font-size="11" fill="#000">${p.want}ms (f${p.file.replace('.png', '')} @${p.t})</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: i * (width + 4), top: 0 });
  }
  await sharp({ create: { width: picks.length * (width + 4), height: h + label, channels: 3, background: '#ffffff' } }).composite(comps).png().toFile(out);
  log(`sheet ${out}: ${picks.length} frames, ${step}ms apart`);
}
