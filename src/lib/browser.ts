/**
 * Shared browser helpers. Every command that opens a page goes through here so the
 * reference capture and the build screenshots are taken under identical conditions
 * (same UA, same DSF, reducedMotion off, same reveal + stitch logic).
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import sharp from 'sharp';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** Framer breakpoints: desktop >=1200, tablet 810..1199, phone <810. 1024 and 810 both land in tablet. */
export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 900 },
  { name: 'tablet-810', width: 810, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;
export type Viewport = { name: string; width: number; height: number };

export function viewportByWidth(w: number): Viewport {
  return VIEWPORTS.find((v) => v.width === w) ?? { name: `w${w}`, width: w, height: w < 600 ? 844 : 900 };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve after `ms` even if the promise never settles (Playwright's close / body calls can hang on a dying target). */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'op'): Promise<T | undefined> {
  return Promise.race([p.catch(() => undefined as T | undefined), sleep(ms).then(() => { log(`  ${label} timed out after ${ms}ms, continuing`); return undefined; })]);
}

/** context.close() that cannot hang the run. */
export async function closeCtx(ctx: BrowserContext, ms = 15_000) {
  await withTimeout(ctx.close(), ms, 'context.close');
}
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

export async function launch(headless = true): Promise<Browser> {
  return chromium.launch({ headless, args: ['--disable-blink-features=AutomationControlled'] });
}

export async function newCtx(browser: Browser, vp: { width: number; height: number }, dsf = 2): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: dsf,
    userAgent: UA,
    reducedMotion: 'no-preference',
    colorScheme: 'light',
    locale: 'en-US',
  });
}

/** Navigate, wait for network idle plus a settle for preloaders / hero appears, disable CSS smooth scroll. */
export async function load(page: Page, url: string, settleMs = 2500) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 }).catch(async () => {
    log('  networkidle timeout, falling back to load');
    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  });
  await page.waitForTimeout(settleMs);
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.body.style.scrollBehavior = 'auto';
  });
}

/** Elements that carry an appear id but never reached opacity ~1 (means the reveal pass missed them). */
export const UNREVEALED_JS = `(() => {
  const out = [];
  for (const e of document.querySelectorAll('[data-framer-appear-id]')) {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const op = parseFloat(cs.opacity);
    if (op < 0.9) out.push({ appearId: e.getAttribute('data-framer-appear-id'), name: e.getAttribute('data-framer-name'), tag: e.tagName.toLowerCase(), opacity: op, transform: cs.transform, y: Math.round(r.top + scrollY), h: Math.round(r.height), inlineStyle: (e.getAttribute('style')||'').slice(0,200) });
  }
  return out;
})()`;

/** Scroll top to bottom in steps so in-view observers fire. Wheel mode cooperates with Lenis. */
export async function revealPass(page: Page, useWheel: boolean, step = 250, waitMs = 120) {
  let y = 0;
  let steps = 0;
  if (useWheel) await page.mouse.move(10, 10);
  while (true) {
    const docH = await page.evaluate(() => document.documentElement.scrollHeight);
    if (y > docH) break;
    if (useWheel) await page.mouse.wheel(0, step);
    else await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(waitMs);
    y += step;
    if (++steps > 4000) break;
  }
  await page.waitForTimeout(1000);
  await scrollTop(page, useWheel);
}

export async function scrollTop(page: Page, useWheel: boolean) {
  if (useWheel) {
    for (let i = 0; i < 400; i++) {
      await page.mouse.wheel(0, -3000);
      await page.waitForTimeout(40);
      const y = await page.evaluate(() => window.scrollY);
      if (y <= 0) break;
    }
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(500);
}

/** Reveal everything: detect whether scrollTo sticks (Lenis resets it), fall back to wheel, then scrollIntoView stragglers. */
export async function reveal(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(150);
  const stuck = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollToWorks = stuck > 300;
  await revealPass(page, !scrollToWorks);
  let unrevealed = (await page.evaluate(UNREVEALED_JS)) as any[];
  let method = scrollToWorks ? 'scrollTo' : 'wheel';
  if (unrevealed.length) {
    await revealPass(page, true);
    await page.evaluate(() => {
      for (const e of document.querySelectorAll('[data-framer-appear-id]')) {
        if (parseFloat(getComputedStyle(e).opacity) < 0.9) e.scrollIntoView({ block: 'center' });
      }
    });
    await page.waitForTimeout(1200);
    await scrollTop(page, true);
    unrevealed = (await page.evaluate(UNREVEALED_JS)) as any[];
    method += '+wheel+scrollIntoView';
  }
  return { unrevealed, method, scrollToWorks };
}

export const HIDE_FIXED_JS = `(() => {
  let n = 0;
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.position === 'fixed' && cs.visibility !== 'hidden' && cs.display !== 'none') {
      const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
      e.setAttribute('data-rig-hidden', e.style.visibility || ''); e.style.visibility = 'hidden'; n++;
    }
  }
  return n;
})()`;
export const RESTORE_FIXED_JS = `(() => { for (const e of document.querySelectorAll('[data-rig-hidden]')) { e.style.visibility = e.getAttribute('data-rig-hidden'); e.removeAttribute('data-rig-hidden'); } })()`;

/**
 * Full page as scroll-and-stitch. Chromium's captureBeyondViewport resizes the viewport to the
 * document height, which re-lays-out vh sections and fires IntersectionObservers (a 13573px page
 * measured 10900 that way). Real viewport chunks stitched together are the truth; fixed elements
 * are hidden after the first chunk, like Chrome's own full-page capture.
 */
export async function stitchFullPage(page: Page, vpW: number, vpH: number, file: string, dsf: number, opts: { chunkWaitMs?: number; wheelNudge?: boolean; background?: string } = {}) {
  const docH = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  const parts: { buf: Buffer; top: number }[] = [];
  let hiddenFixed = 0;
  const wait = opts.chunkWaitMs ?? 250;
  for (let y = 0; y < docH; y += vpH) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    if (opts.wheelNudge) {
      await page.mouse.move(vpW / 2, 10);
      await page.mouse.wheel(0, 1);
    }
    await page.waitForTimeout(y === 0 ? Math.max(400, wait) : wait);
    const actual = await page.evaluate(() => scrollY);
    if (y > 0 && !hiddenFixed) {
      hiddenFixed = (await page.evaluate(HIDE_FIXED_JS)) as number;
      await page.waitForTimeout(50);
    }
    const buf = await page.screenshot({ type: 'png', animations: 'allow', caret: 'hide' });
    parts.push({ buf, top: Math.round(actual * dsf) });
  }
  await page.evaluate(RESTORE_FIXED_JS);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const W = Math.round(vpW * dsf);
  const H = Math.round(docH * dsf);
  const comps: sharp.OverlayOptions[] = [];
  for (const p of parts) {
    const ph = Math.round(vpH * dsf);
    if (p.top + ph > H) {
      const keep = H - p.top;
      if (keep <= 0) continue;
      comps.push({ input: await sharp(p.buf).extract({ left: 0, top: 0, width: W, height: keep }).png().toBuffer(), top: p.top, left: 0 });
    } else comps.push({ input: p.buf, top: p.top, left: 0 });
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: opts.background ?? '#ffffff' } })
    .composite(comps)
    .png()
    .toFile(file);
  return { docH, chunks: parts.length, hiddenFixed };
}

export async function cropFromFull(fullFile: string, clip: { x: number; y: number; width: number; height: number }, file: string, dsf: number) {
  const meta = await sharp(fullFile).metadata();
  const left = Math.max(0, Math.round(clip.x * dsf));
  const top = Math.max(0, Math.round(clip.y * dsf));
  const width = Math.min(meta.width! - left, Math.round(clip.width * dsf));
  const height = Math.min(meta.height! - top, Math.round(clip.height * dsf));
  if (width <= 0 || height <= 0) throw new Error(`crop outside image: ${JSON.stringify(clip)}`);
  await sharp(fullFile).extract({ left, top, width, height }).png().toFile(file);
}

/** Every visible element with its page rect and the computed styles that decide layout. THE box truth. */
export const LAYOUT_JS = `(() => {
  const SKIP = new Set(['SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE','HEAD','TITLE']);
  const props = ['position','display','flexDirection','alignItems','justifyContent','gap','rowGap','columnGap','gridTemplateColumns','width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','color','backgroundColor','backgroundImage','borderRadius','border','boxShadow','opacity','transform','overflow','zIndex','objectFit','mixBlendMode','backdropFilter','filter'];
  const out = [];
  const walk = (el, p) => {
    if (SKIP.has(el.tagName)) return;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    if (visible) {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      own = own.replace(/\\s+/g, ' ').trim().slice(0, 200);
      const rec = {
        path: p, tag: el.tagName.toLowerCase(), id: el.id || undefined,
        className: typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''),
        framerName: el.getAttribute('data-framer-name') || undefined,
        appearId: el.getAttribute('data-framer-appear-id') || undefined,
        text: own || undefined,
        rect: { x: +r.left.toFixed(2), y: +(r.top + scrollY).toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        style: {},
      };
      for (const k of props) { let v = cs[k]; if (k === 'backgroundImage' && v && v.length > 200) v = v.slice(0, 200) + '...'; rec.style[k] = v; }
      if (el.tagName === 'IMG') rec.media = { src: el.getAttribute('src'), currentSrc: el.currentSrc, srcset: (el.getAttribute('srcset')||'').slice(0,300) || undefined, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, alt: el.alt || undefined };
      if (el.tagName === 'VIDEO') rec.media = { src: el.getAttribute('src') || el.querySelector('source')?.getAttribute('src'), currentSrc: el.currentSrc, naturalWidth: el.videoWidth, naturalHeight: el.videoHeight, poster: el.poster || undefined, autoplay: el.autoplay, loop: el.loop, muted: el.muted };
      if (el.tagName === 'A') rec.href = el.getAttribute('href') || undefined;
      out.push(rec);
    }
    let i = 0;
    for (const c of el.children) { walk(c, p + '/' + i); i++; }
  };
  walk(document.body, '0');
  return out;
})()`;

export type Section = { index: number; name: string; slug: string; y: number; h: number; tag: string; selectorHint: string };

/**
 * Top-level sections. Framer: children of the content root (the common parent of the named
 * <section>s) plus its parent's children. Generic sites: <section>/<footer>/<header> or the tall
 * children of <main>/<body>.
 */
export const SECTIONS_JS = `(() => {
  const docH = document.documentElement.scrollHeight;
  const slugOk = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.height >= 100 && r.height <= docH * 0.9 && cs.position !== 'fixed'; };
  const secs = Array.from(document.querySelectorAll('section[data-framer-name]'));
  let cands;
  let mode;
  if (secs.length) {
    const parents = new Map(); for (const s of secs) parents.set(s.parentElement, (parents.get(s.parentElement)||0)+1);
    const root = [...parents.entries()].sort((a,b)=>b[1]-a[1])[0][0];
    cands = [...new Set([...root.children, ...root.parentElement.children])].filter((el) => el !== root && !el.contains(root));
    mode = 'framer';
  } else {
    cands = Array.from(document.querySelectorAll('section, footer, header'));
    if (cands.length < 3) { const root = document.querySelector('main') || document.body; cands = Array.from(root.children); }
    mode = 'generic';
  }
  const out = [];
  for (const el of cands) {
    if (['SCRIPT','STYLE','LINK'].includes(el.tagName)) continue;
    if (!slugOk(el)) continue;
    const r = el.getBoundingClientRect();
    const generic = /^(desktop|tablet|phone|mobile|container|content|wrapper|default|main|page|variant \\d+)$/i;
    let name = el.getAttribute('data-framer-name');
    if (!name || generic.test(name)) {
      const ds = Array.from(el.querySelectorAll('[data-framer-name]')).map(d => d.getAttribute('data-framer-name'));
      const priority = /^(footer|navigation|hero)/i;
      const isLast = Math.round(r.top + scrollY + r.height) >= docH - 5;
      name = ds.find(n => priority.test(n)) || (isLast ? 'Footer' : null) || ds.find(n => !generic.test(n)) || ds[0] || el.id || el.getAttribute('aria-label') || (el.querySelector('h1,h2,h3')?.textContent || '').trim().slice(0, 40) || el.tagName.toLowerCase();
    }
    const hint = el.getAttribute('data-framer-name') ? '[data-framer-name="' + name + '"]' : (el.id ? '#' + el.id : el.tagName.toLowerCase() + ':nth-of-type(' + (Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName).indexOf(el) + 1) + ')');
    out.push({ name, y: Math.round(r.top + scrollY), h: Math.round(r.height), tag: el.tagName.toLowerCase(), selectorHint: hint });
  }
  out.sort((a,b)=>a.y-b.y);
  return { mode, sections: out };
})()`;

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

export async function detectSections(page: Page): Promise<{ mode: string; sections: Section[] }> {
  const res = (await page.evaluate(SECTIONS_JS)) as { mode: string; sections: Omit<Section, 'index' | 'slug'>[] };
  return { mode: res.mode, sections: res.sections.map((s, i) => ({ index: i, slug: slug(s.name), ...s })) };
}

/** Section boxes of a page as printed by `1to1 sections` and used by `verify`. */
export async function measureSections(page: Page) {
  return page.evaluate(() => {
    const out: { y: number; h: number; name: string }[] = [];
    const all = Array.from(document.querySelectorAll('section, footer, header'));
    for (const s of all) {
      const r = s.getBoundingClientRect();
      if (r.height < 50) continue;
      // outermost only: a <footer> inside a <footer> is the same block
      if (all.some((o) => o !== s && o.contains(s))) continue;
      const name = s.getAttribute('data-framer-name') || s.id || s.getAttribute('class') || s.tagName;
      out.push({ y: Math.round(r.top + scrollY), h: Math.round(r.height), name: String(name).slice(0, 40) });
    }
    return { sections: out, docHeight: document.documentElement.scrollHeight };
  });
}
