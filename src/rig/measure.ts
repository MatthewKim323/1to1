/**
 * heights:  page + section heights of one or more URLs at one or more widths, side by side.
 *   1to1 heights <url> [<url2>] [--w 1440,1024,810,390]
 *   Typical: 1to1 heights http://localhost:3777/about "$(1to1 origin reference/site-about --url)"
 *   Columns are labelled build / reference and section names are scrubbed: the output never names the origin.
 *
 * boxes:    element boxes (page coords) of a live page for a y-range, same columns as refboxes.
 *   1to1 boxes <url> <width> <yFrom> <yTo> [--filter text]
 *
 * refboxes: the same columns read from capture/<vp>/layout.json (the reference truth).
 *   1to1 refboxes <reference/name> <vp|width> <yFrom> <yTo> [--filter text]
 *
 * Put boxes and refboxes output next to each other: every remaining pixel shows up as a differing y / h.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from '../lib/args.ts';
import { launch, newCtx, load, reveal, measureSections, viewportByWidth, VIEWPORTS } from '../lib/browser.ts';
import { tokensFor, scrub, originTokens } from '../lib/anon.ts';

export async function runHeights(argv: string[]) {
  const a = new Args(argv);
  const urls = a.positional;
  if (!urls.length) usage('usage: 1to1 heights <url> [<url2>] [--w 1440,1024,810,390] [--json out.json]');
  const widths = a.list('w').map(Number);
  const ws = widths.length ? widths : VIEWPORTS.map((v) => v.width);
  const browser = await launch(true);
  // Origin blackout: label the columns by role and scrub section names, so a heights table never names the source.
  const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(u);
  const refCount = urls.filter((u) => !isLocal(u)).length;
  let refSeen = 0;
  const label = urls.map((u) => (isLocal(u) ? `build ${new URL(u).pathname}` : `reference${refCount > 1 ? ' ' + ++refSeen : ''} ${new URL(u).pathname}`));
  const tokens = urls.filter((u) => !isLocal(u)).flatMap((u) => originTokens(u));
  const clean = (t: string) => scrub(t, tokens, 'brand');
  const result: Record<string, Record<string, { docHeight: number; sections: { y: number; h: number; name: string }[] }>> = {};
  for (const w of ws) {
    const vp = viewportByWidth(w);
    for (const url of urls) {
      const ctx = await newCtx(browser, vp, 1);
      const page = await ctx.newPage();
      await load(page, url, a.num('wait', 2500));
      await reveal(page);
      (result[url] ??= {})[String(w)] = await measureSections(page);
      await ctx.close();
    }
    console.log(`\n== ${w}px`);
    const rows = urls.map((u) => result[u][String(w)]);
    const n = Math.max(...rows.map((r) => r.sections.length));
    const head = ['#', ...label.map((l) => l.slice(0, 34).padEnd(34))].join('  ');
    console.log(head);
    for (let i = 0; i < n; i++) {
      const cells = rows.map((r) => { const s = r.sections[i]; return s ? `${String(s.y).padStart(6)} ${String(s.h).padStart(5)} ${clean(s.name).slice(0, 20)}`.padEnd(34) : ''.padEnd(34); });
      const hs = rows.map((r) => r.sections[i]?.h);
      const flag = hs.length > 1 && hs.some((h) => h !== hs[0]) ? '  <-- differs' : '';
      console.log([String(i).padStart(2), ...cells].join('  ') + flag);
    }
    const dh = rows.map((r) => r.docHeight);
    console.log(['  ', ...dh.map((h) => `doc ${h}`.padEnd(34))].join('  ') + (dh.length > 1 && dh.some((h) => h !== dh[0]) ? `  <-- differs by ${Math.max(...dh) - Math.min(...dh)}px` : dh.length > 1 ? '  == match' : ''));
  }
  await browser.close();
  const json = a.str('json');
  if (json) fs.writeFileSync(json, JSON.stringify(result, null, 1));
}

const BOXES_JS = `(({ y0, y1, filter }) => {
  const out = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (['SCRIPT', 'STYLE', 'svg', 'path', 'use', 'g', 'rect'].includes(el.tagName)) return;
    const r = el.getBoundingClientRect();
    const top = r.top + scrollY;
    if (r.width === 0 || r.height === 0 || top < y0 || top > y1) return;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => (n.textContent || '').trim()).join('').slice(0, 28);
    const name = el.getAttribute('data-framer-name') || (typeof el.className === 'string' ? el.className.split(' ').find((c) => c && !c.startsWith('framer')) : '') || '';
    if (!own && !name) return;
    if (filter && !own.includes(filter) && !name.includes(filter)) return;
    const cs = getComputedStyle(el);
    out.push(top.toFixed(1).padStart(7) + ' ' + r.left.toFixed(1).padStart(6) + ' ' + r.width.toFixed(1).padStart(6) + ' ' + r.height.toFixed(1).padStart(6) + '  ' + el.tagName.toLowerCase().padEnd(7) + ' ' + name.slice(0, 24).padEnd(24) + ' ' + own.padEnd(28) + ' pad=' + cs.paddingTop + '/' + cs.paddingRight + '/' + cs.paddingBottom + '/' + cs.paddingLeft + ' gap=' + cs.gap + ' fd=' + cs.flexDirection + ' ' + cs.fontSize + '/' + cs.lineHeight);
  });
  return out;
})`;

export async function runBoxes(argv: string[]) {
  const a = new Args(argv);
  const [url, wArg, y0Arg, y1Arg] = a.positional;
  if (!url) usage('usage: 1to1 boxes <url> <width> <yFrom> <yTo> [--filter text]');
  const W = +(wArg ?? 1440), y0 = +(y0Arg ?? 0), y1 = +(y1Arg ?? 2000);
  const browser = await launch(true);
  const ctx = await newCtx(browser, viewportByWidth(W), 1);
  const page = await ctx.newPage();
  await load(page, url, a.num('wait', 3000));
  await reveal(page);
  const rows = (await page.evaluate(`${BOXES_JS}(${JSON.stringify({ y0, y1, filter: a.str('filter', '') })})`)) as string[];
  console.log(`      y      x      w      h  tag     name                     text                         styles`);
  console.log(rows.join('\n'));
  await browser.close();
}

export function runRefboxes(argv: string[]) {
  const a = new Args(argv);
  const [root, vpArg, y0Arg, y1Arg] = a.positional;
  if (!root || !vpArg) usage('usage: 1to1 refboxes <reference/name> <vp|width> <yFrom> <yTo> [--filter text]');
  const vp = /^\d+$/.test(vpArg) ? viewportByWidth(+vpArg).name : vpArg;
  const file = path.join(root, 'capture', vp, 'layout.json');
  if (!fs.existsSync(file)) usage(`no ${file}. run: 1to1 capture <url> --only static`);
  const y0 = +(y0Arg ?? 0), y1 = +(y1Arg ?? 2000), flt = a.str('filter', '');
  const L = JSON.parse(fs.readFileSync(file, 'utf8')) as any[];
  const { tokens, brand } = tokensFor(root);   // layout.json is raw capture; nothing printed from it names the origin
  const clean = (t: string) => scrub(t, tokens, brand);
  console.log(`      y      x      w      h  tag     name                     text                         styles`);
  for (const e of L) {
    const r = e.rect || {}, n = clean(e.framerName || ''), t = clean((e.text || '').slice(0, 28));
    if (!(y0 <= r.y && r.y <= y1)) continue;
    if (['svg', 'path', 'use', 'g', 'rect'].includes(e.tag)) continue;
    if (!(n || t)) continue;
    if (flt && !n.includes(flt) && !t.includes(flt)) continue;
    const st = e.style;
    console.log(`${r.y.toFixed(1).padStart(7)} ${r.x.toFixed(1).padStart(6)} ${r.w.toFixed(1).padStart(6)} ${r.h.toFixed(1).padStart(6)}  ${e.tag.padEnd(7)} ${n.slice(0, 24).padEnd(24)} ${t.padEnd(28)} pad=${st.paddingTop}/${st.paddingRight}/${st.paddingBottom}/${st.paddingLeft} gap=${st.gap} fd=${st.flexDirection} ${st.fontSize}/${st.lineHeight}`);
  }
}
