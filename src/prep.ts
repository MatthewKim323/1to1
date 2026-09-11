/**
 * Stage 3: prep. Turn dom/full.html into rebuild-ready spec files inside reference/<name>/:
 *   dom/tree.txt              readable DOM tree: tag [framer name] appear=id .framer-classes {layout-relevant inline styles} "text"
 *   dom/styles.css            every <style> block concatenated
 *   spec/page.txt             the tree + every CSS rule for the classes present, grouped per breakpoint (@base | media)
 *   spec/sections/NN-*.txt    the same, sliced per top-level section (uses capture/report.json when present)
 *   motion/framer-appear.json Framer SSR appear animations (window.__framer__appearAnimationsContent)
 *   modules/*.mjs             every framerusercontent module referenced (page module = the motion source of truth)
 *   assets/svg/<id>.svg       inline <svg id=...> sprite defs
 * usage: 1to1 prep <reference/name>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse, HTMLElement, Node, NodeType } from 'node-html-parser';
import { Args, usage } from './lib/args.ts';
import { cssBlocks, cleanBody, stylesFromHtml } from './lib/css.ts';
import { log } from './lib/browser.ts';
import { readOrigin, scrubSource, scrub } from './lib/anon.ts';

const KEEP = ['position', 'width', 'height', 'top', 'left', 'right', 'bottom', 'opacity', 'transform', 'background', 'border-radius', 'gap', 'padding', 'flex', 'grid', 'z-index', 'overflow', 'aspect-ratio', 'object-fit', 'will-change', 'filter', 'backdrop', 'box-shadow', '--framer-font', '--framer-line', '--framer-letter', '--framer-text-color', '--framer-text-align', 'white-space', 'color', 'mix-blend', 'mask', '--border', 'perspective', 'transform-style'];
const GENERIC = new Set(['framer-text', 'framer-body', 'framer-image', 'framer-styles']);

function decode(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function fmtStyle(st: string) {
  const parts = decode(st).split(';').map((x) => x.trim()).filter(Boolean).filter((x) => KEEP.some((k) => x.startsWith(k)));
  return parts.join('; ').slice(0, 400);
}

export function treeLines(html: string): string[] {
  const bodyIdx = html.indexOf('<body');
  const root = parse(bodyIdx >= 0 ? html.slice(bodyIdx) : html, { comment: false, blockTextElements: { script: true, style: true, noscript: true } });
  const out: string[] = [];
  const walk = (n: Node, depth: number) => {
    if (n.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.rawTagName?.toLowerCase();
    if (!tag || ['script', 'style', 'noscript'].includes(tag)) return;
    const a = el.attributes;
    const bits = [tag];
    if (a['data-framer-name']) bits.push(`[${a['data-framer-name']}]`);
    if (a['data-framer-appear-id']) bits.push('appear=' + a['data-framer-appear-id']);
    if (a.id) bits.push('#' + a.id);
    const fcls = (a.class || '').split(/\s+/).filter((c) => c.startsWith('framer-') && !c.startsWith('framer-v-')).join('.').slice(0, 90);
    if (fcls) bits.push('.' + fcls);
    if (tag === 'img') bits.push('src=' + (a.src || '').slice(0, 90) + ' ' + (a.sizes || '').slice(0, 40));
    if (tag === 'video') bits.push('src=' + (a.src || el.querySelector('source')?.getAttribute('src') || '').slice(0, 90) + (a.autoplay !== undefined ? ' autoplay' : '') + (a.loop !== undefined ? ' loop' : ''));
    if (tag === 'a') bits.push('href=' + (a.href || ''));
    if (tag === 'svg') bits.push('viewBox=' + (a.viewBox || a.viewbox || ''));
    if (tag === 'use') bits.push('href=' + (a.href || a['xlink:href'] || ''));
    if (a['data-border']) bits.push('data-border');
    const st = fmtStyle(a.style || '');
    if (st) bits.push('{' + st + '}');
    const own = el.childNodes.filter((c) => c.nodeType === NodeType.TEXT_NODE).map((c) => decode(c.rawText).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    if (own) bits.push('"' + own.slice(0, 160) + '"');
    const line = '  '.repeat(depth) + bits.join(' ');
    if (!line.includes('opacity: 1; filter: blur(0px)')) out.push(line);
    for (const c of el.childNodes) walk(c, depth + 1);
  };
  for (const c of root.childNodes) walk(c, 0);
  return out;
}

export function specFor(treeText: string, css: string) {
  const keys = new Set<string>();
  for (const m of treeText.matchAll(/framer-[A-Za-z0-9]+/g)) if (!GENERIC.has(m[0])) keys.add(m[0]);
  for (const m of treeText.matchAll(/preset-[A-Za-z0-9]+/g)) keys.add(m[0]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of cssBlocks(css)) {
    if (r.selector.startsWith('@')) continue;
    const parts = r.selector.split(',').map((q) => q.trim()).filter((q) => [...keys].some((k) => new RegExp(`(?<![A-Za-z0-9-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(q)));
    if (!parts.length) continue;
    const key = `${r.media}|${parts.join(',')}|${r.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${r.media || '@base'} | ${parts.join(', ')}\n    ${cleanBody(r.body)}`);
  }
  return out;
}

export async function runPrep(argv: string[]) {
  const a = new Args(argv);
  const root = a.positional[0];
  if (!root || !fs.existsSync(path.join(root, 'dom', 'full.html'))) usage('usage: 1to1 prep <reference/name>   (needs dom/full.html from `1to1 extract`)');
  for (const d of ['dom', 'spec', 'spec/sections', 'motion', 'modules', 'assets/svg']) fs.mkdirSync(path.join(root, d), { recursive: true });

  // Origin blackout, applied once at the source: the rendered html is rewritten before anything is derived
  // from it, so the tree, the spec, the svg defs and every module downstream are already neutral. Links back
  // to the origin become route-relative, which is what the rebuild wants anyway.
  const origin = readOrigin(root);
  const tokens = origin?.tokens ?? [];
  const brand = origin?.brand ?? 'brand';
  const host = origin?.host ?? '';
  const clean = (t: string) => scrubSource(t, tokens, brand, host);
  const raw = fs.readFileSync(path.join(root, 'dom', 'full.html'), 'utf8');
  const src = clean(raw);
  if (src !== raw) fs.writeFileSync(path.join(root, 'dom', 'full.html'), src);

  const css = stylesFromHtml(src);
  fs.writeFileSync(path.join(root, 'dom', 'styles.css'), css);

  const appear = src.match(/<script type="framer\/appear" id="__framer__appearAnimationsContent">([\s\S]*?)<\/script>/);
  if (appear) fs.writeFileSync(path.join(root, 'motion', 'framer-appear.json'), JSON.stringify(JSON.parse(appear[1]), null, 1));

  const modUrls = [...new Set([...src.matchAll(/https:\/\/framerusercontent\.com\/sites\/[^"' ]+\.mjs/g)].map((m) => m[0]))].sort();
  let fetched = 0;
  for (const u of modUrls) {
    const fn = path.join(root, 'modules', scrub(u.split('/').pop()!, tokens, brand));
    if (fs.existsSync(fn)) continue;
    try {
      const r = await fetch(u);
      if (r.ok) { fs.writeFileSync(fn, clean(await r.text())); fetched++; }
      else log('module', r.status, u);
    } catch (e: any) { log('module fail', u, e.message); }
  }

  const svgSeen = new Set<string>();
  for (const m of src.matchAll(/(<svg[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/svg>)/g)) {
    const [, raw, id] = m;
    if (svgSeen.has(id) || raw.includes('data-framer-appear-id')) continue;
    svgSeen.add(id);
    fs.writeFileSync(path.join(root, 'assets', 'svg', `${id}.svg`), decode(raw));
  }

  const lines = treeLines(src);
  const tree = lines.join('\n');
  fs.writeFileSync(path.join(root, 'dom', 'tree.txt'), tree);
  const rules = specFor(tree, css);
  fs.writeFileSync(path.join(root, 'spec', 'page.txt'), '##### TREE #####\n' + tree + '\n\n##### CSS #####\n' + rules.join('\n') + '\n');

  // per-section slices: split the tree at top-level section names from the capture report when available
  const reportFile = path.join(root, 'capture', 'report.json');
  let sectionNames: string[] = [];
  if (fs.existsSync(reportFile)) {
    const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8')).report;
    const vp = rep.sections?.desktop ?? Object.values(rep.sections ?? {})[0];
    if (vp) sectionNames = (vp as any[]).map((s) => s.name);
  }
  let written = 0;
  if (sectionNames.length) {
    const starts: { name: string; idx: number; depth: number }[] = [];
    lines.forEach((l, i) => {
      const depth = l.search(/\S/) / 2;
      for (const n of sectionNames) if (l.includes(`[${n}]`) && !starts.some((s) => s.name === n)) starts.push({ name: n, idx: i, depth });
    });
    starts.sort((x, y) => x.idx - y.idx);
    starts.forEach((s, k) => {
      let end = lines.length;
      for (let j = s.idx + 1; j < lines.length; j++) { if (lines[j].search(/\S/) / 2 <= s.depth) { end = j; break; } }
      const slice = lines.slice(s.idx, end).join('\n');
      const file = path.join(root, 'spec', 'sections', `${String(k).padStart(2, '0')}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.txt`);
      fs.writeFileSync(file, '##### TREE #####\n' + slice + '\n\n##### CSS #####\n' + specFor(slice, css).join('\n') + '\n');
      written++;
    });
  }
  log(`${root}: tree ${lines.length} lines, css rules ${rules.length}, modules ${modUrls.length} (${fetched} new), svg defs ${svgSeen.size}, appear json ${appear ? 'yes' : 'no'}, section specs ${written}`);
}
