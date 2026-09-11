/**
 * Stage 2: capture. The heavy ground truth for a page, under reference/<name>/capture/:
 *   <vp>/full.png            revealed scroll-and-stitch full page (2x)
 *   <vp>/layout.json         every visible element: page rect + layout-deciding computed styles (THE box truth)
 *   <vp>/unrevealed.json     appear-id elements that never reached opacity 1
 *   <vp>/sections/NN-*.png   crops per top-level section
 *   frames/<scenario>/       CDP Page.startScreencast, every compositor frame (~60fps), NNNNN.png + frames.json + motion-timeline.json
 *       load                 fresh page, screencast starts before navigation (preloader + hero appear)
 *       scroll-<section>     section top 85%vh -> 15%vh over 1500ms, then hold (scroll-linked reveals)
 *       hover-<n>-<name>     mouse onto interactive element, hold, off (auto-detected or --hovers file)
 *       click-<n>-<name>     open / close for accordion-like triggers
 *       loop-<n>-<name>      elements that animate by themselves (tickers, pulses); hover analysis (pauses / slows / no change)
 *   assets/                  everything intercepted, manifest.json
 *   README.md + report.json  sections per viewport with y-ranges, scenario table, caveats
 *
 * usage: 1to1 capture <url> [--out reference] [--name slug] [--only static,frames,assets,rediff] [--viewports 1440,1024,810,390]
 *        [--max-hovers 10] [--hovers hovers.json] [--no-scroll-frames] [--frame-dsf 1] [--viewport-timeout 480] [--scenario-timeout 240]
 *        Every viewport / scenario runs under a watchdog; a dead or hung browser is relaunched and the run continues (errors listed in README).
 * hovers.json: [{ "name": "primary-button", "selector": "a[data-framer-name='Primary md']", "text": "View projects", "click": false, "secondary": "a:has-text('Buy')" }]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';
import { Args, usage } from './lib/args.ts';
import { VIEWPORTS, newCtx, load, reveal, revealPass, stitchFullPage, cropFromFull, LAYOUT_JS, detectSections, type Section, log, sleep, withTimeout, closeCtx, BrowserPool, guard } from './lib/browser.ts';
import { slugFromUrl } from './extract.ts';
import { neutralAssetName, originTokens, readOrigin, scrub, writeOrigin, brandFor } from './lib/anon.ts';

const DSF = 2;
const MAX_FRAMES = 400;

type Rect = { x: number; y: number; w: number; h: number };
type HoverSpec = { name: string; selector: string; text?: string; click?: boolean; secondary?: string; secondaryText?: string };

export async function runCapture(argv: string[]) {
  const a = new Args(argv);
  const URL = a.positional[0];
  if (!URL) usage('usage: 1to1 capture <url> [--out reference] [--name slug] [--only static,frames,assets,rediff] [--viewports 1440,1024,810,390] [--max-hovers 10] [--hovers file.json] [--no-scroll-frames] [--frame-dsf 1]');
  const name = a.str('name') ?? slugFromUrl(URL, a.str('out', 'reference'));
  const REF = path.join(process.cwd(), a.str('out', 'reference'), name);
  const OUT = path.join(REF, 'capture');
  // Origin blackout: anything written here that could carry the source's name goes through `anon`.
  const origin = readOrigin(REF);
  const TOKENS = origin?.tokens ?? originTokens(URL, undefined, a.list('tokens'));
  const BRAND = origin?.brand ?? brandFor(process.cwd(), a.str('brand'));
  if (!origin) writeOrigin(REF, { url: URL, host: new globalThis.URL(URL).hostname, tokens: TOKENS, brand: BRAND, capturedAt: new Date().toISOString() });
  const clean = (t: string) => scrub(t, TOKENS, BRAND);
  const ONLY = a.list('only');
  const want = (k: string) => !ONLY.length || ONLY.includes(k);
  const widths = a.list('viewports').map(Number);
  const vps = widths.length ? VIEWPORTS.filter((v) => widths.includes(v.width)) : [...VIEWPORTS];
  const FRAME_DSF = a.num('frame-dsf', 1);
  const MAX_HOVERS = a.num('max-hovers', 10);
  const hoverFile = a.str('hovers');
  const noScrollFrames = a.flag('no-scroll-frames');
  const DESKTOP = vps[0];

  fs.mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  const REPORT_FILE = path.join(OUT, 'report.json');
  const prior = fs.existsSync(REPORT_FILE) ? JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')).report : null;
  const report: any = prior ? { ...prior, viewports: prior.viewports || {}, scenarios: prior.scenarios || {}, sections: prior.sections || {} } : { viewports: {}, scenarios: {}, sections: {}, assets: 0 };

  // ---------------------------------------------------------------- assets
  const assetsDir = path.join(OUT, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const MANIFEST_FILE = path.join(assetsDir, 'manifest.json');
  const manifest: Record<string, { file: string; contentType: string; bytes: number }> = fs.existsSync(MANIFEST_FILE) ? JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) : {};
  const seenUrls = new Set<string>(Object.keys(manifest).filter((u) => manifest[u].bytes >= 0 && fs.existsSync(path.join(assetsDir, manifest[u].file))));
  const assetWrites: Promise<void>[] = [];
  const wantAsset = (u: string, ct: string) => {
    if (/events\.framer\.com|api\.framer\.com|google-analytics|googletagmanager|plausible|segment\.io|sentry/i.test(u)) return false;
    if (/^(image|video|font|audio)\//.test(ct)) return true;
    if (/application\/(font|x-font|vnd\.ms-fontobject)/.test(ct)) return true;
    return /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|woff2?|ttf|otf|eot|glb|gltf|lottie|riv)(\?|$)/i.test(u);
  };
  const attachAssetSniffer = (ctx: BrowserContext) => {
    ctx.on('response', (res) => {
      const u = res.url();
      if (u.startsWith('data:') || seenUrls.has(u)) return;
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!wantAsset(u, ct)) return;
      if (res.status() < 200 || res.status() >= 300) return;
      seenUrls.add(u);
      assetWrites.push((async () => {
        try {
          const body = await withTimeout(res.body(), 20_000, `asset body ${u.slice(-40)}`);
          if (!body) throw new Error('no body');
          const parsed = new globalThis.URL(u);
          let ext = (path.extname(parsed.pathname) || '').toLowerCase();
          if (!/^\.[a-z0-9]{2,5}$/i.test(ext)) {
            const fromType = ct.split('/')[1]?.split(';')[0]?.replace('svg+xml', 'svg').replace('jpeg', 'jpg');
            ext = fromType ? '.' + fromType.replace(/[^a-z0-9]/g, '') : '';
          }
          const bucket = ct.startsWith('video/') ? 'videos' : ct.startsWith('font/') || /\.(woff2?|ttf|otf)$/i.test(ext) ? 'fonts' : ct.startsWith('audio/') ? 'audio' : ct.startsWith('image/') ? 'images' : 'data';
          const file = neutralAssetName(createHash('sha1').update(u).digest('hex').slice(0, 10), ext, bucket);
          fs.writeFileSync(path.join(assetsDir, file), body);
          manifest[u] = { file, contentType: ct, bytes: body.length };
        } catch {
          manifest[u] = { file: '', contentType: ct, bytes: -1 };
        }
      })());
    });
  };
  const ctxFor = async (browser: Browser, vp: { width: number; height: number }, dsf = DSF) => {
    const ctx = await newCtx(browser, vp, dsf);
    attachAssetSniffer(ctx);
    return ctx;
  };

  // ---------------------------------------------------------------- static per viewport
  async function captureViewport(browser: Browser, vp: (typeof VIEWPORTS)[number]) {
    log(`== viewport ${vp.name} ${vp.width}x${vp.height}`);
    const dir = path.join(OUT, vp.name);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await ctxFor(browser, vp);
    const page = await ctx.newPage();
    const vpReport: any = { width: vp.width, height: vp.height };
    try {
      await load(page, URL);
      const { unrevealed, method } = await reveal(page);
      vpReport.revealMethod = method;
      vpReport.unrevealed = unrevealed.length;
      fs.writeFileSync(path.join(dir, 'unrevealed.json'), JSON.stringify(unrevealed, null, 2));
      if (unrevealed.length) log(`  WARNING ${unrevealed.length} unrevealed elements`);

      const fullFile = path.join(dir, 'full.png');
      const { docH, chunks, hiddenFixed } = await stitchFullPage(page, vp.width, vp.height, fullFile, DSF);
      vpReport.docHeight = docH;
      vpReport.stitchChunks = chunks;
      vpReport.hiddenFixedElements = hiddenFixed;
      log(`  full.png (${vp.width}x${docH} css px, ${chunks} chunks, ${hiddenFixed} fixed hidden after chunk 0)`);

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      const layout = (await page.evaluate(LAYOUT_JS)) as any[];
      fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout));
      vpReport.layoutElements = layout.length;
      log(`  layout.json (${layout.length} elements)`);

      const detected = await detectSections(page);
      const mode = detected.mode;
      // section names become component names in the rebuild, so they never carry the origin
      const sections = detected.sections.map((sec) => ({ ...sec, name: clean(sec.name), slug: clean(sec.slug) }));
      vpReport.sectionMode = mode;
      report.sections[vp.name] = sections;
      const sdir = path.join(dir, 'sections');
      fs.mkdirSync(sdir, { recursive: true });
      for (const s of sections) {
        const file = path.join(sdir, `${String(s.index).padStart(2, '0')}-${s.slug}.png`);
        try { await cropFromFull(fullFile, { x: 0, y: s.y, width: vp.width, height: s.h }, file, DSF); } catch (e: any) { errors.push(`[${vp.name}] section ${s.slug}: ${e.message}`); }
        log(`  section ${s.index} ${s.name} y=${s.y} h=${s.h}`);
      }
    } catch (e: any) {
      errors.push(`[${vp.name}] ${e.stack || e.message}`);
      log('  ERROR', e.message);
    } finally {
      report.viewports[vp.name] = vpReport;
      await closeCtx(ctx);
    }
  }

  // ---------------------------------------------------------------- screencast
  class Screencast {
    frames: { i: number; t: number; file: string; ts: number }[] = [];
    roi: Rect | null = null;
    private cdp!: CDPSession;
    private dir: string;
    private t0 = 0;
    private stopped = false;
    private writes: Promise<any>[] = [];
    constructor(public name: string) {
      this.dir = path.join(OUT, 'frames', name);
      fs.mkdirSync(this.dir, { recursive: true });
      for (const f of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, f));
    }
    async start(page: Page, vp: { width: number; height: number }) {
      this.cdp = await page.context().newCDPSession(page);
      this.cdp.on('Page.screencastFrame', (ev: any) => {
        const { data, metadata, sessionId } = ev;
        if (!this.stopped) {
          const i = this.frames.length;
          const file = `${String(i).padStart(5, '0')}.png`;
          const ts = metadata.timestamp;
          this.frames.push({ i, t: Math.round((ts - this.t0) * 1000), file, ts });
          this.writes.push(fs.promises.writeFile(path.join(this.dir, file), Buffer.from(data, 'base64')));
          if (this.frames.length >= MAX_FRAMES) this.stop().catch(() => {});
        }
        this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      this.t0 = Date.now() / 1000;
      await this.cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: Math.round(vp.width * FRAME_DSF), maxHeight: Math.round(vp.height * FRAME_DSF) });
    }
    async stop() {
      if (this.stopped) return;
      this.stopped = true;
      try { await this.cdp.send('Page.stopScreencast'); } catch {}
    }
    async finish(extra: Record<string, any> = {}) {
      await this.stop();
      await Promise.all(this.writes);
      try { await this.cdp.detach(); } catch {}
      const sorted = [...this.frames].sort((a, b) => a.ts - b.ts);
      for (const f of sorted) fs.renameSync(path.join(this.dir, f.file), path.join(this.dir, 'tmp-' + f.file));
      sorted.forEach((f, i) => { const nf = `${String(i).padStart(5, '0')}.png`; fs.renameSync(path.join(this.dir, 'tmp-' + f.file), path.join(this.dir, nf)); f.file = nf; f.i = i; });
      this.frames = sorted;
      const motion = await motionTimeline(this.dir, this.frames, this.roi);
      const out = { scenario: this.name, frameCount: this.frames.length, frameDsf: FRAME_DSF, capped: this.frames.length >= MAX_FRAMES, tZero: 't = ms since Page.startScreencast was sent (frame swap timestamp); negative t = stale frame composited before recording began', ...extra, frames: this.frames.map(({ i, t, file }) => ({ i, t, file })) };
      fs.writeFileSync(path.join(this.dir, 'frames.json'), JSON.stringify(out, null, 1));
      fs.writeFileSync(path.join(this.dir, 'motion-timeline.json'), JSON.stringify(motion, null, 1));
      report.scenarios[this.name] = { frames: this.frames.length, durationMs: this.frames.at(-1)?.t ?? 0, motion: motion.summary, ...extra };
      log(`  [${this.name}] ${this.frames.length} frames, motion ${motion.summary.firstMotionMs}->${motion.summary.lastMotionMs}ms, ranges=${JSON.stringify(motion.summary.ranges)}`);
      return out;
    }
  }

  async function motionTimeline(dir: string, frames: { i: number; t: number; file: string }[], roi: Rect | null) {
    const PIX_DELTA = 20, ROI_DELTA = 3, THRESH = 0.0003, ROI_MAD_THRESH = 0.03, W = 480;
    let prev: Buffer | null = null;
    let roiPx: { left: number; top: number; width: number; height: number } | null = null;
    let prevRoi: Buffer | null = null, baseRoi: Buffer | null = null;
    const rows: any[] = [];
    for (const f of frames) {
      let changed = 0, roiMad = 0, roiVsBase = 0;
      try {
        const { data: raw } = await sharp(path.join(dir, f.file)).resize({ width: W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        if (prev && prev.length === raw.length) {
          let n = 0;
          for (let k = 0; k < raw.length; k += 3) if (Math.abs(raw[k] - prev[k]) > PIX_DELTA || Math.abs(raw[k + 1] - prev[k + 1]) > PIX_DELTA || Math.abs(raw[k + 2] - prev[k + 2]) > PIX_DELTA) n++;
          changed = n / (raw.length / 3);
        } else if (prev) changed = 1;
        prev = raw;
        if (roi) {
          if (!roiPx) {
            const fm = await sharp(path.join(dir, f.file)).metadata();
            const m = 40, sx = fm.width! / DESKTOP.width, sy = fm.height! / DESKTOP.height;
            const left = Math.max(0, Math.floor((roi.x - m) * sx)), top = Math.max(0, Math.floor((roi.y - m) * sy));
            roiPx = { left, top, width: Math.max(1, Math.min(fm.width! - left, Math.ceil((roi.w + 2 * m) * sx))), height: Math.max(1, Math.min(fm.height! - top, Math.ceil((roi.h + 2 * m) * sy))) };
          }
          const rr = await sharp(path.join(dir, f.file)).extract(roiPx).removeAlpha().raw().toBuffer();
          if (!baseRoi) baseRoi = rr;
          if (prevRoi && prevRoi.length === rr.length) {
            let sum = 0, nb = 0;
            for (let k = 0; k < rr.length; k += 3) {
              sum += Math.abs(rr[k] - prevRoi[k]) + Math.abs(rr[k + 1] - prevRoi[k + 1]) + Math.abs(rr[k + 2] - prevRoi[k + 2]);
              if (Math.abs(rr[k] - baseRoi[k]) > ROI_DELTA || Math.abs(rr[k + 1] - baseRoi[k + 1]) > ROI_DELTA || Math.abs(rr[k + 2] - baseRoi[k + 2]) > ROI_DELTA) nb++;
            }
            roiMad = sum / rr.length;
            roiVsBase = nb / (rr.length / 3);
          } else if (prevRoi) { roiMad = 255; roiVsBase = 1; }
          prevRoi = rr;
        }
      } catch (e: any) { errors.push(`diff ${dir}/${f.file}: ${e.message}`); }
      const row: any = { i: f.i, t: f.t, changed: +changed.toFixed(5), motion: f.i > 0 && changed > THRESH };
      if (roi) { row.roiMad = +roiMad.toFixed(4); row.roiChangedVsBase = +roiVsBase.toFixed(5); row.motionRoi = f.i > 0 && roiMad > ROI_MAD_THRESH; }
      rows.push(row);
    }
    if (roi) for (const r of rows) r.motion = !!r.motionRoi;
    const motionRows = rows.filter((r) => r.motion);
    const ranges: { startMs: number; endMs: number; frames: number }[] = [];
    for (const r of motionRows) {
      const last = ranges.at(-1);
      if (last && r.t - last.endMs <= 120) { last.endMs = r.t; last.frames++; } else ranges.push({ startMs: r.t, endMs: r.t, frames: 1 });
    }
    return {
      method: `sharp raw diff, downscaled to ${W}px wide, pixel changed if any channel delta > ${PIX_DELTA}; frame is motion if changed fraction > ${THRESH}` + (roi ? `; ROI mode (target rect + 40px, full res): roiMad = mean abs per-channel diff vs previous frame, motion if > ${ROI_MAD_THRESH}; roiChangedVsBase = fraction of ROI pixels differing > ${ROI_DELTA} from frame 0` : ''),
      roi: roi || undefined,
      summary: { firstMotionMs: motionRows[0]?.t ?? null, lastMotionMs: motionRows.at(-1)?.t ?? null, motionFrames: motionRows.length, totalFrames: rows.length, ranges },
      frames: rows,
    };
  }

  // ---------------------------------------------------------------- scenarios
  const freshPage = async (browser: Browser) => {
    const ctx = await ctxFor(browser, DESKTOP, FRAME_DSF);
    return { ctx, page: await ctx.newPage() };
  };

  async function scenarioLoad(browser: Browser) {
    const { ctx, page } = await freshPage(browser);
    const sc = new Screencast('load');
    try {
      await sc.start(page, DESKTOP);
      const t = Date.now();
      page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => errors.push('load goto: ' + e.message));
      await sleep(Math.max(0, 6000 - (Date.now() - t)));
      await sc.finish({ description: 'fresh page; screencast started before navigation; 6s' });
    } catch (e: any) { errors.push(`[load] ${e.message}`); } finally { await closeCtx(ctx); }
  }

  async function scenarioScroll(browser: Browser, s: Section) {
    const { ctx, page } = await freshPage(browser);
    const name = `scroll-${s.slug}`;
    const sc = new Screencast(name);
    try {
      await load(page, URL);
      const top = await page.evaluate((hint) => { const el = document.querySelector(hint); return el ? Math.round(el.getBoundingClientRect().top + scrollY) : null; }, s.selectorHint);
      const y0 = (top ?? s.y) - Math.round(DESKTOP.height * 0.85);
      const y1 = (top ?? s.y) - Math.round(DESKTOP.height * 0.15);
      await sc.start(page, DESKTOP);
      await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, y0));
      await page.waitForTimeout(400);
      const tScrollStart = sc.frames.at(-1)?.t ?? 0;
      await page.evaluate(({ from, to, dur }) => {
        const t0 = performance.now();
        const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
        const step = () => { const p = Math.min(1, (performance.now() - t0) / dur); window.scrollTo(0, from + (to - from) * ease(p)); if (p < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      }, { from: Math.max(0, y0), to: Math.max(0, y1), dur: 1500 });
      await page.waitForTimeout(1500 + 2500);
      await sc.finish({ description: `section "${s.name}" top ${y0}->${y1} (85%->15% vh) over 1500ms, then 2500ms hold`, sectionTop: top ?? s.y, scrollFrom: y0, scrollTo: y1, smoothScrollStartMsApprox: tScrollStart });
    } catch (e: any) { errors.push(`[${name}] ${e.message}`); } finally { await closeCtx(ctx); }
  }

  async function rectOf(page: Page, selector: string, text?: string, nth = 0): Promise<Rect | null> {
    let loc = page.locator(selector);
    if (text) loc = loc.filter({ hasText: text });
    loc = loc.filter({ visible: true });
    const n = await loc.count();
    if (!n) return null;
    const el = loc.nth(Math.min(nth, n - 1));
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const bb = await el.boundingBox();
    return bb ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height } : null;
  }

  /** Interactive elements spread across the page: real links / buttons / triggers, ranked buttons > cards > nav links > other, deduped by name + text. */
  const AUTO_HOVERS_JS = `((max) => {
    const generic = /^(desktop|tablet|phone|mobile|container|content|wrapper|default|main|page|icon|variant \\d+|frame|group|stack|row|column)$/i;
    const ownName = (el) => { const n = el.getAttribute('data-framer-name'); return n && !generic.test(n) ? n : null; };
    const nearName = (el) => { let e = el; for (let i = 0; i < 3 && e; i++, e = e.parentElement) { const n = e.getAttribute && e.getAttribute('data-framer-name'); if (n && !generic.test(n)) return n; } return null; };
    const seen = new Set(); const out = [];
    for (const el of document.querySelectorAll('a[href], button, [role="button"], [aria-expanded]')) {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 16 || cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      let fixed = false; for (let e = el; e; e = e.parentElement) { if (getComputedStyle(e).position === 'fixed') { fixed = true; break; } }
      if (fixed) continue;
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      const own = ownName(el), near = nearName(el);
      const hasImg = !!el.querySelector('img, video');
      const isTrigger = el.hasAttribute('aria-expanded') || /trigger|accordion|faq|toggle|question/i.test((near || '') + ' ' + el.className);
      if (!text && !hasImg && !isTrigger) continue;
      const key = ((own || near || '') + '|' + text).toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      const inNav = !!el.closest('nav, header, [data-framer-name*="Navigation" i]');
      const isButton = el.tagName === 'BUTTON' || /button|primary|secondary|cta|pill|tab/i.test((own || near || '') + ' ' + el.className) || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && !hasImg && text.length < 30);
      const kind = isTrigger ? 'trigger' : hasImg ? 'card' : inNav ? 'nav' : isButton ? 'button' : 'link';
      const rank = { button: 0, card: 1, trigger: 2, nav: 3, link: 4 }[kind];
      const sec = el.closest('section, footer, [data-framer-name]:not([data-framer-name=""])');
      out.push({ name: ((own || text || near || el.tagName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)) || el.tagName.toLowerCase(), text: text || undefined, framerName: own || undefined, nearName: near || undefined, y: Math.round(r.top + scrollY), kind, rank, click: isTrigger, section: sec ? (sec.getAttribute('data-framer-name') || sec.tagName.toLowerCase()) : '', tag: el.tagName.toLowerCase() });
    }
    out.sort((a, b) => a.rank - b.rank || a.y - b.y);
    // one per (section, kind) first so the sample spreads across the page, then fill by rank
    const picked = []; const keys = new Set();
    for (const c of out) { const k = c.section + '|' + c.kind; if (!keys.has(k)) { keys.add(k); picked.push(c); } }
    for (const c of out) if (picked.length < max && !picked.includes(c)) picked.push(c);
    return picked.slice(0, max).sort((a, b) => a.y - b.y);
  })(${MAX_HOVERS})`;

  async function autoHoverSpecs(page: Page): Promise<HoverSpec[]> {
    const cands = (await page.evaluate(AUTO_HOVERS_JS)) as any[];
    return cands.map((c, i) => ({
      name: `${i}-${c.name}`,
      selector: c.framerName ? `${c.tag}[data-framer-name="${c.framerName.replace(/"/g, '\\"')}"], [data-framer-name="${c.framerName.replace(/"/g, '\\"')}"] ${c.tag}` : c.tag,
      text: c.text,
      click: !!c.click,
    }));
  }

  async function scenarioHovers(browser: Browser, specs: HoverSpec[]) {
    const { ctx, page } = await freshPage(browser);
    try {
      await load(page, URL);
      await reveal(page);
      for (const t of specs) {
        const name = `${t.click ? 'click' : 'hover'}-${t.name}`;
        const sc = new Screencast(name);
        try {
          await page.mouse.move(5, 5);
          const r = await rectOf(page, t.selector, t.text);
          if (!r) { errors.push(`[${name}] target not found (${t.selector} ${t.text ?? ''})`); fs.rmSync(path.join(OUT, 'frames', name), { recursive: true, force: true }); continue; }
          await page.evaluate((cy) => window.scrollBy(0, cy - innerHeight / 2), r.y + r.h / 2);
          await page.waitForTimeout(900);
          const r2 = (await rectOf(page, t.selector, t.text)) || r;
          const cx = r2.x + r2.w / 2, cy = r2.y + r2.h / 2;
          const hy = t.secondary ? r2.y + Math.min(60, r2.h / 3) : cy;
          const offX = Math.max(10, Math.min(DESKTOP.width - 10, cx)), offY = r2.y > 200 ? r2.y - 150 : r2.y + r2.h + 150;
          sc.roi = r2;
          await sc.start(page, DESKTOP);
          await page.waitForTimeout(300);
          const marks: Record<string, number> = {};
          const mark = (k: string) => (marks[k] = sc.frames.at(-1)?.t ?? 0);
          mark('moveOnStart');
          await page.mouse.move(cx, hy, { steps: 10 });
          mark('moveOnEnd');
          await page.waitForTimeout(1500);
          if (t.secondary) {
            const c = await rectOf(page, t.secondary, t.secondaryText);
            if (c) { mark('moveToSecondaryStart'); await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2, { steps: 10 }); mark('moveToSecondaryEnd'); await page.waitForTimeout(1500); }
          }
          if (t.click) {
            mark('click1'); await page.mouse.click(cx, cy); await page.waitForTimeout(1800);
            mark('click2'); await page.mouse.click(cx, cy); await page.waitForTimeout(1800);
          }
          mark('moveOffStart');
          await page.mouse.move(offX, Math.max(10, Math.min(DESKTOP.height - 10, offY)), { steps: 10 });
          mark('moveOffEnd');
          await page.waitForTimeout(1000);
          await sc.finish({ description: `${t.click ? 'hover + click open/close' : 'hover'} ${t.name}${t.secondary ? ' + move to secondary' : ''}`, selector: t.selector, text: t.text, targetRect: r2, marksMs: marks });
        } catch (e: any) { errors.push(`[${name}] ${e.message}`); try { await sc.finish({ error: e.message }); } catch {} }
      }
    } catch (e: any) { errors.push(`[hovers] ${e.message}`); } finally { await closeCtx(ctx); }
  }

  /** Elements whose transform / opacity / background-position keeps changing with no input (sampled 3x over 1.2s after settling): tickers, pulses, canvases. Fixed elements (scroll-driven navs) are excluded. */
  const LOOPS_JS = `(async () => {
    await new Promise(r => setTimeout(r, 1500));
    const sample = () => { const m = new Map(); let i = 0; for (const el of document.querySelectorAll('body *')) { if (i++ > 6000) break; const r = el.getBoundingClientRect(); if (r.width < 40 || r.height < 12) continue; const cs = getComputedStyle(el); m.set(el, cs.transform + '|' + cs.opacity + '|' + cs.backgroundPosition + '|' + cs.filter); } return m; };
    const a = sample(); await new Promise(r => setTimeout(r, 600)); const b = sample(); await new Promise(r => setTimeout(r, 600)); const c = sample();
    const isFixed = (el) => { for (let e = el; e; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return true; return false; };
    const out = [];
    for (const [el, v] of a) { if (b.get(el) !== undefined && b.get(el) !== v && c.get(el) !== b.get(el) && !isFixed(el)) { const r = el.getBoundingClientRect(); out.push({ el, y: Math.round(r.top + scrollY), h: Math.round(r.height), w: Math.round(r.width) }); } }
    for (const cv of document.querySelectorAll('canvas')) { const r = cv.getBoundingClientRect(); if (r.width > 40 && !isFixed(cv)) out.push({ el: cv, y: Math.round(r.top + scrollY), h: Math.round(r.height), w: Math.round(r.width), canvas: true }); }
    const keep = out.filter(o => !out.some(p => p !== o && p.el.contains(o.el)));
    return keep.slice(0, 6).map((o, i) => { const named = o.el.closest('[data-framer-name]'); o.el.setAttribute('data-1to1-loop', String(i)); return { index: i, name: (named?.getAttribute('data-framer-name') || o.el.tagName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30), y: o.y, h: o.h, w: o.w, canvas: !!o.canvas }; });
  })()`;

  async function scenarioLoops(browser: Browser) {
    const { ctx, page } = await freshPage(browser);
    try {
      await load(page, URL);
      await reveal(page);
      const loops = (await page.evaluate(LOOPS_JS)) as { index: number; name: string; y: number; h: number; w: number; canvas: boolean }[];
      report.loops = loops;
      log(`  ${loops.length} self-animating element(s) detected`);
      for (const l of loops) {
        const name = `loop-${l.index}-${l.name}`;
        const sc = new Screencast(name);
        try {
          const sel = `[data-1to1-loop="${l.index}"]`;
          const r = await rectOf(page, sel);
          if (!r) throw new Error('loop target lost');
          await page.evaluate((cy) => window.scrollBy(0, cy - innerHeight / 2), r.y + r.h / 2);
          await page.waitForTimeout(1200);
          const r2 = (await rectOf(page, sel)) || r;
          await page.mouse.move(5, 5);
          sc.roi = r2;
          await sc.start(page, DESKTOP);
          await page.waitForTimeout(4000);
          const hoverAt = sc.frames.at(-1)?.t ?? 4000;
          await page.mouse.move(r2.x + r2.w / 2, r2.y + r2.h / 2, { steps: 10 });
          await page.waitForTimeout(2000);
          const fin = await sc.finish({ description: `4s unhovered, then hover 2s (${l.canvas ? 'canvas' : 'self-animating element'})`, hoverStartMs: hoverAt, targetRect: r2 });
          const mt = JSON.parse(fs.readFileSync(path.join(OUT, 'frames', name, 'motion-timeline.json'), 'utf8'));
          if (!l.canvas && mt.summary.motionFrames < 20) {
            // an appear animation or lazy image finishing, not a loop: drop it
            fs.rmSync(path.join(OUT, 'frames', name), { recursive: true, force: true });
            delete report.scenarios[name];
            log(`  [${name}] only ${mt.summary.motionFrames} motion frames in ${fin.frameCount}: transient, dropped`);
          } else hoverAnalysis(name);
        } catch (e: any) { errors.push(`[${name}] ${e.message}`); try { await sc.finish({ error: e.message }); } catch {} }
      }
    } catch (e: any) { errors.push(`[loops] ${e.message}`); } finally { await closeCtx(ctx); }
  }

  function hoverAnalysis(name: string) {
    const dir = path.join(OUT, 'frames', name);
    const fj = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
    const mt = JSON.parse(fs.readFileSync(path.join(dir, 'motion-timeline.json'), 'utf8'));
    const hoverAt = fj.hoverStartMs, lastT = fj.frames.at(-1)?.t ?? hoverAt;
    const pre = mt.frames.filter((f: any) => f.i > 0 && f.t < hoverAt), post = mt.frames.filter((f: any) => f.t > hoverAt + 300);
    const mean = (a: any[]) => (a.length ? a.reduce((s, f) => s + (f.roiMad ?? f.changed), 0) / a.length : 0);
    const analysis = { preHoverFrames: pre.length, preHoverMeanChange: +mean(pre).toFixed(5), preHoverFps: +(pre.length / (hoverAt / 1000)).toFixed(1), postHoverFrames: post.length, postHoverMeanChange: +mean(post).toFixed(5), postHoverFps: +(post.length / Math.max(0.001, (lastT - hoverAt - 300) / 1000)).toFixed(1) };
    const verdict = post.length === 0 || mean(post) < mean(pre) * 0.15 ? 'PAUSES on hover' : mean(post) < mean(pre) * 0.7 ? 'SLOWS on hover' : 'no change on hover';
    mt.hoverAnalysis = { ...analysis, verdict };
    fs.writeFileSync(path.join(dir, 'motion-timeline.json'), JSON.stringify(mt, null, 1));
    report.scenarios[name] = { ...(report.scenarios[name] || {}), hover: { ...analysis, verdict } };
    log(`  [${name}] ${verdict}`);
  }

  async function rediffAll() {
    const fdir = path.join(OUT, 'frames');
    if (!fs.existsSync(fdir)) return;
    for (const name of fs.readdirSync(fdir).sort()) {
      const dir = path.join(fdir, name);
      const fjPath = path.join(dir, 'frames.json');
      if (!fs.existsSync(fjPath)) continue;
      const fj = JSON.parse(fs.readFileSync(fjPath, 'utf8'));
      const motion = await motionTimeline(dir, fj.frames, fj.targetRect || null);
      fs.writeFileSync(path.join(dir, 'motion-timeline.json'), JSON.stringify(motion, null, 1));
      const { frames: _f, frameCount, frameDsf, capped, tZero, ...extra } = fj;
      report.scenarios[name] = { frames: fj.frames.length, durationMs: fj.frames.at(-1)?.t ?? 0, motion: motion.summary, ...extra };
      if (fj.hoverStartMs) hoverAnalysis(name);
    }
  }

  // ---------------------------------------------------------------- README
  function writeReadme() {
    for (const n of Object.keys(report.scenarios)) if (!fs.existsSync(path.join(OUT, 'frames', n, 'frames.json'))) delete report.scenarios[n];
    const L: string[] = [];
    L.push(`# capture: ${name}`, '', `Captured: ${new Date().toISOString()} (source url in ../.origin.json; never repeat it in the rebuild)`, `Rig: 1to1 capture (Playwright ${require('playwright/package.json').version}, headless Chromium, UA spoofed, reducedMotion=no-preference)`, '');
    L.push(`## Viewports (deviceScaleFactor ${DSF})`, '', '| name | size | doc height | layout elements | reveal method | unrevealed |', '|---|---|---|---|---|---|');
    for (const [n, v] of Object.entries<any>(report.viewports)) L.push(`| ${n} | ${v.width}x${v.height} | ${v.docHeight ?? '?'} | ${v.layoutElements ?? '?'} | ${v.revealMethod ?? '?'} | ${v.unrevealed ?? '?'} |`);
    L.push('', 'Per viewport: `<vp>/full.png` (revealed full page), `<vp>/layout.json` (flat array: path/tag/class/framerName/appearId/text/rect(page coords)/computed styles/media), `<vp>/unrevealed.json`, `<vp>/sections/NN-<name>.png`.', '');
    L.push('## Sections detected', '');
    for (const [vp, secs] of Object.entries<any>(report.sections)) {
      L.push(`### ${vp}`, '', '| # | name | tag | y | h | y-range |', '|---|---|---|---|---|---|');
      for (const s of secs) L.push(`| ${s.index} | ${s.name} | ${s.tag} | ${s.y} | ${s.h} | ${s.y}-${s.y + s.h} |`);
      L.push('');
    }
    L.push('Selection rule: the outermost visible elements that are >= 100px tall, >= 200px wide and <= 90% of the document height, not position:fixed. Name = own data-framer-name (unless generic), else a Footer / Navigation / Hero descendant name, else the first non-generic descendant name, id, aria-label or first heading.', '');
    L.push(`## Frame scenarios (${DESKTOP.width}x${DESKTOP.height}, CDP Page.startScreencast png everyFrame, frames at ${FRAME_DSF}x, cap ${MAX_FRAMES})`, '', '| scenario | frames | duration ms | motion first->last ms | motion ranges | notes |', '|---|---|---|---|---|---|');
    for (const [n, s] of Object.entries<any>(report.scenarios)) {
      const m = s.motion || {};
      const notes = [s.description, s.hover ? `hover: ${s.hover.verdict} (pre ${s.hover.preHoverMeanChange}@${s.hover.preHoverFps}fps -> post ${s.hover.postHoverMeanChange}@${s.hover.postHoverFps}fps)` : '', s.marksMs ? `marks: ${JSON.stringify(s.marksMs)}` : '', s.error ? `ERROR ${s.error}` : ''].filter(Boolean).join('; ');
      L.push(`| ${n} | ${s.frames} | ${s.durationMs} | ${m.firstMotionMs ?? '-'}->${m.lastMotionMs ?? '-'} | ${(m.ranges || []).map((r: any) => `${r.startMs}-${r.endMs}`).join(', ')} | ${notes} |`);
    }
    L.push('', 'Each `frames/<scenario>/` has `NNNNN.png`, `frames.json` (t = ms since Page.startScreencast; the compositor only emits a frame when something repainted, so gaps = nothing changed) and `motion-timeline.json` (per-frame changed-pixel fraction; `motion` flag + merged ranges). Contact sheets: `1to1 sheet <frames dir> <out.png>`.', '');
    L.push('Scroll scenarios: screencast starts, instant scrollTo(sectionTop - 85% vh), 400ms settle, rAF ease-in-out scroll to (sectionTop - 15% vh) over 1500ms, 2500ms hold. Fresh page per scenario so appear animations replay.', '');
    L.push('## Unrevealed elements', '');
    let any = false;
    for (const n of Object.keys(report.viewports)) {
      const f = path.join(OUT, n, 'unrevealed.json');
      if (fs.existsSync(f)) { const u = JSON.parse(fs.readFileSync(f, 'utf8')); if (u.length) { any = true; L.push(`- ${n}: ${u.length}: ${u.map((x: any) => `${x.tag}[${x.appearId}]${x.name ? ' "' + x.name + '"' : ''} y=${x.y} opacity=${x.opacity}`).join('; ')}`); } }
    }
    if (!any) L.push('None. Every element with data-framer-appear-id ended at computed opacity >= 0.9 in every viewport.');
    L.push('', '## Assets', '', `${Object.keys(manifest).length} unique URLs intercepted -> \`assets/<img|vid|font|audio|data>-<sha1(url)[0:10]>.<ext>\` (content addressed: the origin's own filenames are dropped), map in \`assets/manifest.json\` (analytics excluded; bytes=-1 had no readable body).`, '');
    L.push('## Caveats', '',
      '- Full pages are scroll-and-stitch. captureBeyondViewport resizes the viewport to the content height, which re-lays-out vh sections and fires IntersectionObservers, so it is not used. Sticky / scroll-linked sections show the state at each chunk\'s scroll offset; use the scroll-* frame sequences for their true motion.',
      `- Screencast frames are ${FRAME_DSF}x (--frame-dsf). PNG at ${DESKTOP.width}x${DESKTOP.height} yields ~30-60 fps of changed frames.`,
      '- Hover scenarios diff only inside the target rect (+40px) so animated textures elsewhere do not count as motion.',
      '- `--only rediff` recomputes every motion-timeline.json from frames on disk; `--only static` / `--only frames` restrict the run. report.json is merged across runs.', '');
    L.push('## Errors', '', errors.length ? errors.map((e) => `- ${e}`).join('\n') : 'None.', '');
    fs.writeFileSync(path.join(OUT, 'README.md'), L.join('\n'));
  }

  // ---------------------------------------------------------------- main
  const pool = new BrowserPool(true);
  const VIEWPORT_MS = a.num('viewport-timeout', 8 * 60) * 1000;
  const SCENARIO_MS = a.num('scenario-timeout', 4 * 60) * 1000;
  /** run a unit; on timeout or a dead browser, record the error and relaunch so the next unit gets a fresh browser */
  const unit = async (label: string, ms: number, fn: (b: Browser) => Promise<unknown>) => {
    const r = await guard(label, ms, async () => fn(await pool.get()));
    if (!r.ok) {
      errors.push(`[${label}] ${r.reason}`);
      if (r.timedOut || !(await pool.get()).isConnected()) await pool.reset();
    }
    return r.ok;
  };
  try {
    if (want('static')) for (const vp of vps) {
      // one retry on a fresh browser: a slow CDN or a dead Chromium should not cost a viewport
      const ok = await unit(`viewport ${vp.name}`, VIEWPORT_MS, (b) => captureViewport(b, vp));
      if (!ok) { await pool.reset(); log(`  retrying viewport ${vp.name}`); await unit(`viewport ${vp.name} (retry)`, VIEWPORT_MS, (b) => captureViewport(b, vp)); }
    }
    if (want('assets') && ONLY.includes('assets')) {
      for (const vp of vps) {
        await unit(`assets ${vp.name}`, VIEWPORT_MS, async (b) => {
          const ctx = await ctxFor(b, vp);
          const page = await ctx.newPage();
          try { await load(page, URL); await revealPass(page, false); } finally { await closeCtx(ctx); }
        });
      }
    }
    if (ONLY.includes('rediff')) await rediffAll();
    if (want('frames') && !ONLY.includes('rediff')) {
      log('== frame scenarios');
      fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
      let sections: Section[] = report.sections[DESKTOP.name];
      let hoverSpecs: HoverSpec[] = [];
      await unit('frame setup', SCENARIO_MS, async (b) => {
        const ctx = await ctxFor(b, DESKTOP, FRAME_DSF);
        const page = await ctx.newPage();
        try {
          await load(page, URL);
          await reveal(page);
          if (!sections) { sections = (await detectSections(page)).sections; report.sections[DESKTOP.name] = sections; }
          hoverSpecs = hoverFile ? JSON.parse(fs.readFileSync(hoverFile, 'utf8')) : await autoHoverSpecs(page);
          report.hoverTargets = hoverSpecs;
          log(`  ${hoverSpecs.length} hover/click targets`);
        } finally { await closeCtx(ctx); }
      });
      await unit('scenario load', SCENARIO_MS, (b) => scenarioLoad(b));
      if (!noScrollFrames) for (const s of (sections ?? []).slice(1)) await unit(`scenario scroll-${s.slug}`, SCENARIO_MS, (b) => scenarioScroll(b, s));
      for (const h of hoverSpecs) await unit(`scenario hover ${h.name}`, SCENARIO_MS, (b) => scenarioHovers(b, [h]));
      await unit('scenario loops', SCENARIO_MS * 2, (b) => scenarioLoops(b));
    }
  } catch (e: any) {
    errors.push(`fatal: ${e.stack || e.message}`);
    log('FATAL', e);
  } finally {
    await Promise.allSettled(assetWrites.map((p) => withTimeout(p, 5_000, 'asset write')));
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    report.assets = Object.keys(manifest).length;
    for (const n of Object.keys(report.scenarios)) if (!fs.existsSync(path.join(OUT, 'frames', n, 'frames.json'))) delete report.scenarios[n];
    fs.writeFileSync(REPORT_FILE, JSON.stringify({ report, errors }, null, 2));
    writeReadme();
    await pool.close();
    log(`done -> ${OUT} (errors: ${errors.length})`);
  }
}
