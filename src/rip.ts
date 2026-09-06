/**
 * Stage 4: rip. Pull the motion truth out of Framer's page modules (one giant minified line each)
 * into readable windows so the spec can be written from source instead of guessed from video.
 *   motion/modules.md          per module: size, exported component names (framer-XXXXX scope classes), what patterns it contains
 *   motion/constants.json      every `const X={...type:"spring"|"tween"...}` transition constant, per module
 *   motion/rip.md              context windows (+-N chars) around every known Framer motion pattern:
 *                              __framer__transformTargets / __framer__spring (scroll "Enter" effects),
 *                              __framer__targets / __framer__threshold (variant switch on scroll),
 *                              tokenization (text effects), tickerEffect*, drag / dragTransition,
 *                              repeat:Infinity loops, useScroll / scrollY, whileHover / onHoverStart variant maps,
 *                              canvas / getContext / WebGL shaders (fragmentShader, gl_FragColor)
 *   motion/appear-by-name.json framer-appear.json joined with the DOM: appear id -> framer name, tag, text, first breakpoint values
 * usage: 1to1 rip <reference/name> [--window 600] [--pattern extraRegex]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from './lib/args.ts';
import { log } from './lib/browser.ts';

const PATTERNS: { key: string; re: RegExp; why: string }[] = [
  { key: 'scroll-transform', re: /__framer__transformTargets/g, why: 'Framer "Enter" effect: scroll-progress-linked (offset start end / end end), first target = from state, __framer__spring = chase spring. NOT whileInView.' },
  { key: 'scroll-target', re: /__framer__transformTrigger:[`"']onScrollTarget[`"']/g, why: 'transform driven by a scroll marker element (fixed nav reveal).' },
  { key: 'variant-on-scroll', re: /__framer__threshold/g, why: 'variant switch by scroll ranges built from __framer__targets refs; animateOnce:false flips back.' },
  { key: 'text-effect', re: /tokenization:[`"'](character|word|line)[`"']/g, why: 'per token appear: spring + stagger (0.05s default), trigger onMount or onInView threshold.' },
  { key: 'ticker', re: /tickerEffect/g, why: 'Ticker component props: speed, direction, gap, hover, fade edges, draggable.' },
  { key: 'drag', re: /dragTransition|dragSnapToOrigin|drag:!0|drag:[`"'][xy][`"']/g, why: 'draggable elements with inertia snap-back.' },
  { key: 'loop', re: /repeat:1\/0|repeat:Infinity|repeatType/g, why: 'infinite loops (pulses, rotating arrows).' },
  { key: 'scroll-hook', re: /useScroll\(|scrollY|useTransform\(/g, why: 'custom scroll-linked code components.' },
  { key: 'hover-variant', re: /-hover[`"']|onHoverStart|whileHover|useActiveVariantCallback/g, why: 'gesture variant maps; the component `transition` constant applies.' },
  { key: 'appear-runtime', re: /startOptimizedAppearAnimation|animateAppearEffect/g, why: 'SSR appear runtime hooks.' },
  { key: 'canvas', re: /getContext\([`"'](2d|webgl2?)[`"']\)|gl_FragColor|fragmentShader|precision (high|medium)p float/g, why: 'canvas / WebGL code to port verbatim (shader source, uniforms, draw loop).' },
  { key: 'route-transition', re: /enter:\{opacity/g, why: 'page/route transition.' },
];

export async function runRip(argv: string[]) {
  const a = new Args(argv);
  const root = a.positional[0];
  if (!root || !fs.existsSync(path.join(root, 'modules'))) usage('usage: 1to1 rip <reference/name> [--window 600] [--pattern regex]   (needs modules/ from `1to1 prep`)');
  const WIN = a.num('window', 600);
  const extra = a.str('pattern');
  const pats = extra ? [...PATTERNS, { key: 'custom', re: new RegExp(extra, 'g'), why: 'user pattern' }] : PATTERNS;
  const mdir = path.join(root, 'modules');
  const files = fs.readdirSync(mdir).filter((f) => f.endsWith('.mjs')).map((f) => ({ f, size: fs.statSync(path.join(mdir, f)).size })).sort((x, y) => y.size - x.size);
  fs.mkdirSync(path.join(root, 'motion'), { recursive: true });

  const modLines = ['# Modules', '', '| module | KB | scope classes (components) | display names | patterns |', '|---|---|---|---|---|'];
  const constants: Record<string, Record<string, string>> = {};
  const rip: string[] = ['# Ripped motion windows', '', `> ${WIN} chars of context around each match. Modules are minified single lines; read the object literals, they are the exact values Framer ships. Never round.`, ''];
  for (const { f, size } of files) {
    const src = fs.readFileSync(path.join(mdir, f), 'utf8');
    if (/^\/\/ vendor|react\.|rolldown-runtime|^framer\.|^motion\./.test(f) || /rolldown-runtime|^react\./.test(f)) {
      modLines.push(`| ${f} | ${(size / 1024).toFixed(0)} | runtime / vendor | | |`);
      continue;
    }
    const scopes = [...new Set([...src.matchAll(/[`"'](framer-[A-Za-z0-9]{5})[`"']/g)].map((m) => m[1]))];
    const names = [...new Set([...src.matchAll(/displayName\s*[=:]\s*[`"']([^`"']{1,60})[`"']/g)].map((m) => m[1]))];
    const hits: string[] = [];
    for (const p of pats) { const n = (src.match(p.re) || []).length; if (n) hits.push(`${p.key}:${n}`); }
    modLines.push(`| ${f} | ${(size / 1024).toFixed(0)} | ${scopes.slice(0, 12).join(' ')}${scopes.length > 12 ? ` +${scopes.length - 12}` : ''} | ${names.slice(0, 10).join(', ')} | ${hits.join(' ')} |`);

    const consts: Record<string, string> = {};
    for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)=(\{[^{}]*type:[`"'](?:spring|tween|inertia|keyframes)[`"'][^{}]*\})/g)) consts[m[1]] = m[2];
    if (Object.keys(consts).length) constants[f] = consts;

    if (!hits.length) continue;
    rip.push(`## ${f} (${(size / 1024).toFixed(0)} KB)`, '');
    if (Object.keys(consts).length) {
      rip.push('### transition constants', '', '```js');
      for (const [k, v] of Object.entries(consts)) rip.push(`const ${k}=${v}`);
      rip.push('```', '');
    }
    for (const p of pats) {
      const idxs: number[] = [];
      for (const m of src.matchAll(p.re)) { if (m.index !== undefined) idxs.push(m.index); }
      if (!idxs.length) continue;
      // merge windows that overlap so the same code is not printed twice
      const merged: [number, number][] = [];
      for (const i of idxs) {
        const s = Math.max(0, i - WIN), e = Math.min(src.length, i + WIN);
        const last = merged.at(-1);
        if (last && s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
      }
      rip.push(`### ${p.key} (${idxs.length} match${idxs.length > 1 ? 'es' : ''}, ${merged.length} window${merged.length > 1 ? 's' : ''})`, '', `_${p.why}_`, '');
      for (const [s, e] of merged.slice(0, 40)) rip.push('```js', `// @${s}`, src.slice(s, e), '```', '');
      if (merged.length > 40) rip.push(`_... ${merged.length - 40} more windows; grep the module directly._`, '');
    }
  }
  fs.writeFileSync(path.join(root, 'motion', 'modules.md'), modLines.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'motion', 'constants.json'), JSON.stringify(constants, null, 1));
  fs.writeFileSync(path.join(root, 'motion', 'rip.md'), rip.join('\n'));

  // appear ids joined with DOM names
  const appearFile = path.join(root, 'motion', 'framer-appear.json');
  const treeFile = path.join(root, 'dom', 'tree.txt');
  if (fs.existsSync(appearFile) && fs.existsSync(treeFile)) {
    const appear = JSON.parse(fs.readFileSync(appearFile, 'utf8'));
    const tree = fs.readFileSync(treeFile, 'utf8').split('\n');
    const joined: Record<string, any> = {};
    for (const [id, bps] of Object.entries<any>(appear)) {
      const line = tree.find((l) => l.includes(`appear=${id}`)) || '';
      const name = line.match(/\[([^\]]+)\]/)?.[1];
      const text = line.match(/"([^"]+)"$/)?.[1];
      const tag = line.trim().split(' ')[0];
      const first = Object.entries<any>(bps || {}).find(([, v]) => v);
      joined[id] = { name, tag, text, breakpoints: Object.keys(bps || {}), sample: first ? { breakpoint: first[0], initial: first[1].initial, animate: first[1].animate } : null, allIdentical: first ? Object.values<any>(bps).every((v) => !v || JSON.stringify(v) === JSON.stringify(first[1])) : null };
    }
    fs.writeFileSync(path.join(root, 'motion', 'appear-by-name.json'), JSON.stringify(joined, null, 1));
    log(`appear ids joined: ${Object.keys(joined).length}`);
  }
  log(`rip -> ${root}/motion/{modules.md,constants.json,rip.md}: ${files.length} modules, ${Object.values(constants).reduce((n, c) => n + Object.keys(c).length, 0)} transition constants`);
}
