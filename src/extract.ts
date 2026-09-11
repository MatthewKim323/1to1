/**
 * Stage 1: extract. Fast first pass over one URL.
 *   dom/full.html            rendered DOM after a full reveal pass (inline styles, appear ids, framer names)
 *   screenshots/<vp>-full.png revealed, scroll-and-stitch full pages at 1440 / 1024 / 810 / 390
 *   stack/detected.md        framework sniffing
 *   tokens/*.json + tokens.css
 *   motion/animations.json + motion/observed.md   CDP Animation events + computed transitions (observed, not invented)
 *   assets/{images,videos,fonts,audio}/ + manifest.json
 *   meta.json
 * Heavy truth (layout.json, section crops, 60fps frames) is stage 2: `1to1 capture`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page, CDPSession, Request } from 'playwright';
import { Args, usage } from './lib/args.ts';
import { VIEWPORTS, newCtx, load, reveal, stitchFullPage, log, withTimeout, closeCtx, BrowserPool, guard } from './lib/browser.ts';
import { originTokens, neutralRefName, neutralAssetName, writeOrigin, readOrigin, brandFor, isReservedToken } from './lib/anon.ts';

export type Stack = { framework: string; framer: boolean; framerMotion: boolean; webflow: boolean; lenis: boolean; gsap: boolean; three: boolean; spline: boolean; notes: string[] };

/**
 * Reference dir name. Structure only: `/` -> site, `/about` -> site-about. The origin never names a folder
 * (see lib/anon.ts). A second, unrelated origin in the same project gets -2, -3 rather than reusing the dir.
 */
export function slugFromUrl(url: string, out = 'reference') {
  const base = neutralRefName(url, originTokens(url));
  const root = join(process.cwd(), out);
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    const dir = join(root, name);
    if (!existsSync(dir)) return name;
    const o = readOrigin(dir);
    if (!o || o.url === url) return name;
  }
  return base;
}

export async function runExtract(argv: string[]) {
  const a = new Args(argv);
  const url = a.positional[0];
  if (!url) usage('usage: 1to1 extract <url> [--out reference] [--name slug] [--brand Name] [--tokens a,b] [--headless] [--viewports 1440,1024,810,390]');
  const name = a.str('name') ?? slugFromUrl(url, a.str('out', 'reference'));
  const outDir = join(process.cwd(), a.str('out', 'reference'), name);
  const headless = a.flag('headless');
  const widths = a.list('viewports').map(Number);
  const vps = widths.length ? VIEWPORTS.filter((v) => widths.includes(v.width)) : [...VIEWPORTS];
  const t0 = Date.now();
  log(`extract ${url} -> ${outDir} (headed=${!headless})`);
  for (const d of ['dom', 'screenshots', 'stack', 'tokens', 'motion', 'assets']) await mkdir(join(outDir, d), { recursive: true });

  const pool = new BrowserPool(headless);
  const browser = await pool.get();
  const ctx = await newCtx(browser, VIEWPORTS[0], 1);
  const page = await ctx.newPage();
  const assets = attachAssets(page, outDir);

  log('phase 1: load + reveal');
  await load(page, url);
  const title = await page.title();
  const { method, unrevealed } = await reveal(page);
  log(`  "${title}" reveal=${method} unrevealed=${unrevealed.length}`);

  log('phase 2: stack');
  const stack = await detectStack(page);
  log(`  ${JSON.stringify({ ...stack, notes: undefined })}`);

  log('phase 3: dom');
  await writeFile(join(outDir, 'dom', 'full.html'), await page.content(), 'utf8');

  log('phase 4: tokens');
  const tokens = await extractTokens(page);
  await writeTokens(outDir, tokens);

  log('phase 5: observed motion (CDP Animation + computed transitions)');
  const cdp = await ctx.newCDPSession(page);
  const cdpAnims = await captureCDPAnimations(cdp, page);
  const computed = await scanComputed(page);
  await writeFile(join(outDir, 'motion', 'animations.json'), JSON.stringify({ capturedAt: new Date().toISOString(), stack, computed, cdp: cdpAnims }, null, 1), 'utf8');
  await writeFile(join(outDir, 'motion', 'observed.md'), observedMd(computed, cdpAnims, stack), 'utf8');
  log(`  ${computed.length} elements with transitions, ${cdpAnims.length} CDP animations`);
  await closeCtx(ctx);

  log('phase 6: revealed full pages');
  const heights: Record<string, number> = {};
  const errors: string[] = [];
  for (const vp of vps) {
    const g = await guard(`full page ${vp.name}`, a.num('viewport-timeout', 6 * 60) * 1000, async () => {
      const b = await pool.get();
      const c = await newCtx(b, vp, 2);
      try {
        const p = await c.newPage();
        attachAssets(p, outDir, assets);
        await load(p, url);
        await reveal(p);
        const file = join(outDir, 'screenshots', `${vp.name}-full.png`);
        const r = await stitchFullPage(p, vp.width, vp.height, file, 2);
        heights[vp.name] = r.docH;
        log(`  ${vp.name} ${vp.width}x${r.docH} (${r.chunks} chunks)`);
      } finally { await closeCtx(c); }
    });
    if (!g.ok) { errors.push(`[${vp.name}] ${g.reason}`); if (g.timedOut) await pool.reset(); }
  }

  await assets.finalize();
  await writeFile(join(outDir, 'stack', 'detected.md'), stackMd(stack), 'utf8');
  // Origin blackout: the url and the page title live in .origin.json and nowhere else. meta.json, the briefs,
  // the specs and everything copied into the project stay neutral.
  const brand = brandFor(process.cwd(), a.str('brand'));
  const originWords = originTokens(url, title, a.list('tokens'));
  writeOrigin(outDir, { url, host: new URL(url).hostname, title, tokens: originWords, brand, capturedAt: new Date().toISOString() });
  const risky = originWords.filter(isReservedToken);
  if (risky.length) log(`  blackout: ${risky.join(', ')} also read as web vocabulary, so only the capitalized spelling is scrubbed`);
  log(`  blackout: ${originWords.length} origin token(s) -> "${brand}"; origin kept only in ${name}/.origin.json`);
  const meta = { name, capturedAt: new Date().toISOString(), brand, stack, viewports: vps, docHeights: heights, revealMethod: method, unrevealed: unrevealed.length, animationCount: computed.length + cdpAnims.length, assetCount: assets.manifest.length, errors };
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await pool.close();
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}`);
  return { outDir, meta };
}

// ---------------------------------------------------------------- stack
async function detectStack(page: Page): Promise<Stack> {
  return page.evaluate(() => {
    const html = document.documentElement.outerHTML.slice(0, 300000);
    const scripts = Array.from(document.scripts).map((s) => s.src + ' ' + (s.textContent || '').slice(0, 4000)).join('\n');
    const has = (re: RegExp) => re.test(html) || re.test(scripts);
    const s: any = {
      framework: 'unknown',
      framer: has(/framerusercontent\.com|data-framer-name/i),
      framerMotion: has(/framer-motion|data-framer|\bmotion\b\.[A-Za-z]+\.mjs/i),
      webflow: has(/webflow|w-nav|w-container/i),
      lenis: has(/lenis|data-stylokit-smooth-scroll/i) || !!document.querySelector('html.lenis, .lenis'),
      gsap: has(/gsap|GreenSock|ScrollTrigger/i),
      three: has(/three\.js|three\.module|THREE\./i),
      spline: has(/splinetool/i),
      notes: [],
    };
    if (has(/__NEXT_DATA__|_next\/static/i)) s.framework = 'next';
    else if (has(/__SVELTEKIT_|sveltekit/i)) s.framework = 'svelte';
    else if (has(/__nuxt|_nuxt\//i)) s.framework = 'vue';
    else if (s.framer) s.framework = 'framer';
    else if (has(/react-dom|_reactRoot|data-reactroot/i)) s.framework = 'react';
    if (s.framer) s.notes.push('Built with Framer: appear ids, data-framer-name, framerusercontent modules. Use `1to1 prep` + `1to1 rip`.');
    if (s.lenis) s.notes.push('Lenis smooth scroll present: window.scrollTo may be overridden, rigs fall back to wheel events.');
    if (s.gsap) s.notes.push('GSAP present: look for ScrollTrigger configs in the bundles.');
    if (document.querySelector('canvas')) s.notes.push(`${document.querySelectorAll('canvas').length} canvas element(s): WebGL / 2D drawing to port (find the module that draws it).`);
    if (document.querySelector('video')) s.notes.push(`${document.querySelectorAll('video').length} video element(s).`);
    if (Array.from(document.images).some((i) => /\.gif(\?|$)/i.test(i.currentSrc || i.src))) s.notes.push('Animated GIF textures present (repaint every frame; diff rigs need an ROI).');
    return s as Stack;
  });
}

function stackMd(s: Stack) {
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return ['# Detected stack', '', `- framework: ${s.framework}`, `- built with Framer: ${yn(s.framer)}`, `- framer-motion runtime: ${yn(s.framerMotion)}`, `- Webflow: ${yn(s.webflow)}`, `- Lenis: ${yn(s.lenis)}`, `- GSAP: ${yn(s.gsap)}`, `- three.js: ${yn(s.three)}`, `- Spline: ${yn(s.spline)}`, '', '## Notes', ...s.notes.map((n) => `- ${n}`), ''].join('\n');
}

// ---------------------------------------------------------------- tokens
type Tokens = ReturnType<typeof tokensShape>;
function tokensShape() {
  return { colors: [] as { value: string; usage: number }[], fontFamilies: [] as { value: string; usage: number }[], fontSizes: [] as { value: string; usage: number }[], fontWeights: [] as { value: string; usage: number }[], lineHeights: [] as { value: string; usage: number }[], spacing: [] as { value: string; usage: number }[], radii: [] as { value: string; usage: number }[], shadows: [] as { value: string; usage: number }[], cssVars: {} as Record<string, string> };
}
async function extractTokens(page: Page): Promise<Tokens> {
  return page.evaluate(() => {
    const maps: Record<string, Map<string, number>> = {};
    const bump = (m: string, k: string) => {
      if (!k) return;
      (maps[m] ??= new Map()).set(k, ((maps[m].get(k) ?? 0) + 1));
    };
    let n = 0;
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (n++ > 12000) break;
      const cs = getComputedStyle(el);
      if (cs.color && cs.color !== 'rgba(0, 0, 0, 0)') bump('colors', cs.color);
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bump('colors', cs.backgroundColor);
      if (cs.borderTopColor && cs.borderTopStyle !== 'none' && cs.borderTopColor !== 'rgba(0, 0, 0, 0)') bump('colors', cs.borderTopColor);
      bump('fontFamilies', cs.fontFamily);
      if (el.childNodes.length && Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.nodeValue!.trim())) {
        bump('fontSizes', cs.fontSize);
        bump('fontWeights', cs.fontWeight);
        bump('lineHeights', cs.lineHeight);
      }
      for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'rowGap', 'columnGap'] as const) {
        const v = cs[p];
        if (v && v !== '0px' && v !== 'normal') bump('spacing', v);
      }
      if (cs.borderRadius && cs.borderRadius !== '0px') bump('radii', cs.borderRadius);
      if (cs.boxShadow && cs.boxShadow !== 'none') bump('shadows', cs.boxShadow);
    }
    // CSS custom properties declared on :root / body (Framer emits --token-<uuid> with hex fallbacks in rules)
    const cssVars: Record<string, string> = {};
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules || [])) {
        const st = (r as CSSStyleRule).style;
        if (!st) continue;
        for (let i = 0; i < st.length; i++) {
          const p = st[i];
          if (p.startsWith('--') && Object.keys(cssVars).length < 400) cssVars[p] = st.getPropertyValue(p).trim();
        }
      }
    }
    const sorted = (m: string) => [...(maps[m] ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 48).map(([value, usage]) => ({ value, usage }));
    return { colors: sorted('colors'), fontFamilies: sorted('fontFamilies'), fontSizes: sorted('fontSizes'), fontWeights: sorted('fontWeights'), lineHeights: sorted('lineHeights'), spacing: sorted('spacing'), radii: sorted('radii'), shadows: sorted('shadows'), cssVars };
  });
}
async function writeTokens(outDir: string, t: Tokens) {
  await writeFile(join(outDir, 'tokens', 'colors.json'), JSON.stringify(t.colors, null, 1));
  await writeFile(join(outDir, 'tokens', 'typography.json'), JSON.stringify({ fontFamilies: t.fontFamilies, sizes: t.fontSizes, weights: t.fontWeights, lineHeights: t.lineHeights }, null, 1));
  await writeFile(join(outDir, 'tokens', 'spacing.json'), JSON.stringify({ spacing: t.spacing, radii: t.radii, shadows: t.shadows }, null, 1));
  await writeFile(join(outDir, 'tokens', 'css-vars.json'), JSON.stringify(t.cssVars, null, 1));
  const lines = [':root {'];
  t.colors.forEach((c, i) => lines.push(`  --color-${i + 1}: ${c.value}; /* used ${c.usage}x */`));
  t.fontFamilies.slice(0, 4).forEach((f, i) => lines.push(`  --font-${i + 1}: ${f.value}; /* used ${f.usage}x */`));
  lines.push('}');
  await writeFile(join(outDir, 'tokens', 'tokens.css'), lines.join('\n'));
}

// ---------------------------------------------------------------- motion (observed)
type Computed = { selector: string; tag: string; text?: string; transition?: string; animation?: string; framer: Record<string, string> };
async function scanComputed(page: Page): Promise<Computed[]> {
  return page.evaluate(() => {
    const sel = (el: Element) => {
      const parts: string[] = [];
      let n: Element | null = el;
      while (n && n !== document.body && parts.length < 5) {
        let p = n.tagName.toLowerCase();
        const cls = typeof (n as HTMLElement).className === 'string' ? (n as HTMLElement).className.trim().split(/\s+/).filter((c) => c && !c.startsWith('framer-v-')).slice(0, 2).join('.') : '';
        if (cls) p += '.' + cls;
        parts.unshift(p);
        n = n.parentElement;
      }
      return parts.join(' > ');
    };
    const out: any[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      const tr = cs.transitionProperty && cs.transitionProperty !== 'none' && cs.transitionDuration !== '0s';
      const an = cs.animationName && cs.animationName !== 'none';
      const framer: Record<string, string> = {};
      for (const [k, v] of Object.entries((el as HTMLElement).dataset)) if (k.startsWith('framer') && v) framer[k] = v.slice(0, 120);
      if (!tr && !an && !Object.keys(framer).length) continue;
      out.push({ selector: sel(el), tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 60) || undefined, transition: tr ? `${cs.transitionProperty} ${cs.transitionDuration} ${cs.transitionTimingFunction} ${cs.transitionDelay}` : undefined, animation: an ? `${cs.animationName} ${cs.animationDuration} ${cs.animationTimingFunction} ${cs.animationDelay} ${cs.animationIterationCount}` : undefined, framer });
      if (out.length > 3000) break;
    }
    return out;
  });
}
type CdpAnim = { id: string; type: string; duration: number; delay: number; easing: string; iterations: number; keyframes?: { offset: string; easing?: string }[] };
async function captureCDPAnimations(cdp: CDPSession, page: Page): Promise<CdpAnim[]> {
  const out: CdpAnim[] = [];
  await cdp.send('Animation.enable');
  cdp.on('Animation.animationStarted', (evt: any) => {
    const a = evt.animation;
    const src = a.source || {};
    out.push({ id: a.id, type: a.type, duration: src.duration ?? 0, delay: src.delay ?? 0, easing: src.easing ?? 'linear', iterations: src.iterations ?? 1, keyframes: src.keyframesRule?.keyframes?.map((k: any) => ({ offset: k.offset, easing: k.easing })) });
  });
  // fresh reveal from the top so appear + scroll animations fire while we listen
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.mouse.move(10, 10);
  const docH = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < docH; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(800);
  await cdp.send('Animation.disable').catch(() => {});
  return out;
}
function observedMd(computed: Computed[], cdp: CdpAnim[], stack: Stack) {
  const L = ['# Observed motion', '', '> Recorded from the live page. Everything here was measured; nothing was invented. For Framer sites the real spec lives in the page module: run `1to1 rip` and read docs/FRAMER.md.', ''];
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  L.push('## Easings seen', '');
  for (const [e, n] of count([...cdp.map((a) => a.easing), ...computed.map((c) => c.transition?.split(' ')[2] ?? '').filter(Boolean)]).slice(0, 15)) L.push(`- \`${e}\` x${n}`);
  L.push('', '## Durations seen', '');
  for (const [d, n] of count([...cdp.map((a) => `${a.duration}ms`), ...computed.map((c) => c.transition?.split(' ')[1] ?? '').filter(Boolean)]).slice(0, 15)) L.push(`- \`${d}\` x${n}`);
  if (cdp.length) {
    L.push('', '## CDP Animation events (first 80)', '', '| # | type | duration | delay | easing | iterations |', '|---|---|---|---|---|---|');
    cdp.slice(0, 80).forEach((a, i) => L.push(`| ${i + 1} | ${a.type} | ${a.duration}ms | ${a.delay}ms | \`${a.easing}\` | ${a.iterations} |`));
  }
  const notable = computed.filter((c) => c.transition || c.animation).slice(0, 60);
  if (notable.length) {
    L.push('', '## Elements with CSS transitions / animations', '');
    for (const c of notable) L.push(`- \`${c.selector}\`${c.text ? ` "${c.text}"` : ''}${c.transition ? `\n  transition: ${c.transition}` : ''}${c.animation ? `\n  animation: ${c.animation}` : ''}`);
  }
  if (stack.framer) L.push('', 'Framer appear animations are WAAPI keyframes pre-sampled from springs; the CDP table shows them as WebAnimation with linear easing. The spring values are in `motion/framer-appear.json` (after `1to1 prep`).');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- assets
type Manifest = { originalUrl: string; localPath: string; type: string; bytes: number; mime: string }[];
type Collector = { manifest: Manifest; seen: Set<string>; pending: Promise<void>[]; finalize: () => Promise<void> };
/** Sniff every image / video / font / audio / data response into assets/. Pass an existing collector to share state across pages. */
export function attachAssets(page: Page, outDir: string, shared?: Collector): Collector {
  const manifest: Manifest = shared?.manifest ?? [];
  const seen = shared?.seen ?? new Set<string>();
  const pending = shared?.pending ?? [];
  page.on('response', (response) => {
    const req: Request = response.request();
    const url = req.url();
    if (seen.has(url) || url.startsWith('data:')) return;
    if (/events\.framer\.com|api\.framer\.com|google-analytics|googletagmanager|plausible|segment\.io|sentry/i.test(url)) return;
    const type = req.resourceType();
    const mime = (response.headers()['content-type'] || '').split(';')[0].trim();
    let bucket = '';
    if (type === 'image' || mime.startsWith('image/')) bucket = 'images';
    else if (type === 'media' || mime.startsWith('video/')) bucket = 'videos';
    else if (type === 'font' || mime.startsWith('font/') || /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) bucket = 'fonts';
    else if (mime.startsWith('audio/')) bucket = 'audio';
    else if (/\.(json|glb|gltf|lottie|riv)(\?|$)/i.test(url) && !/\/_next\//.test(url)) bucket = 'data';
    if (!bucket) return;
    seen.add(url);
    pending.push((async () => {
      const buf = await withTimeout(response.body(), 20_000, 'asset body');
      if (!buf) return;
      const ext = extname(new URL(url).pathname).toLowerCase() || ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'font/woff2': '.woff2', 'font/woff': '.woff' } as Record<string, string>)[mime] || '';
      const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
      const file = neutralAssetName(hash, ext || extname(new URL(url).pathname).toLowerCase(), bucket);
      const dir = join(outDir, 'assets', bucket);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, file), buf);
      manifest.push({ originalUrl: url, localPath: join('assets', bucket, file), type: bucket, bytes: buf.length, mime });
    })());
  });
  return {
    manifest,
    seen,
    pending,
    finalize: async () => {
      await Promise.allSettled(pending);
      await mkdir(join(outDir, 'assets'), { recursive: true });
      await writeFile(join(outDir, 'assets', 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
      log(`  ${manifest.length} assets harvested`);
    },
  };
}

export function referenceDirFor(url: string, out = 'reference', name?: string) {
  const dir = join(process.cwd(), out, name ?? slugFromUrl(url, out));
  return { dir, exists: existsSync(dir) };
}
