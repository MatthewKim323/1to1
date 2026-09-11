/**
 * Origin blackout. Nothing the rebuild ships may name where it came from.
 *
 * One file holds the origin: `reference/<name>/.origin.json` (host, url, title, tokens). It exists so the
 * rigs can still re-capture and compare against the live page. Everything else the tool writes is neutral:
 * reference dir names, harvested asset filenames, section names, the spec trees, the briefs, the prompts.
 * `scanLeaks` is the gate: it walks a project and fails on any surviving mention.
 *
 * Vocabulary: an "origin token" is a word that identifies the source (brand, host label, product name).
 * "brand" is the replacement the rebuild uses for itself, defaulting to the project folder name.
 */
import fs from 'node:fs';
import path from 'node:path';

export type Origin = { url: string; host: string; title?: string; tokens: string[]; brand: string; capturedAt: string };

/** Hosting suffixes that say nothing about the site; stripped before the brand is read off the hostname. */
const PLATFORM_SUFFIXES = [
  'framer.website', 'framer.app', 'framer.media', 'framer.wiki', 'webflow.io', 'vercel.app', 'netlify.app',
  'netlify.com', 'github.io', 'pages.dev', 'workers.dev', 'notion.site', 'super.site', 'carrd.co', 'glitch.me',
  'surge.sh', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'azurewebsites.net', 'replit.app', 'repl.co',
  'bubbleapps.io', 'softr.app', 'myshopify.com', 'squarespace.com', 'wixsite.com', 'cargo.site', 'readymag.com',
  'webnode.page', 'durable.co', 'w3spaces.com', 'onrender.com', 'fly.dev',
];

/** Words that are too generic to be an identity, so never banned on their own. */
const GENERIC = new Set([
  'the', 'and', 'for', 'you', 'your', 'our', 'get', 'try', 'use', 'new', 'now', 'all', 'app', 'apps', 'web',
  'site', 'sites', 'page', 'pages', 'home', 'index', 'main', 'www', 'com', 'net', 'org', 'dev', 'io', 'ai',
  'co', 'inc', 'llc', 'ltd', 'gmbh', 'hq', 'team', 'group', 'studio', 'studios', 'agency', 'labs', 'lab',
  'design', 'designs', 'digital', 'media', 'creative', 'company', 'online', 'official', 'work', 'works',
  'portfolio', 'tech', 'cloud', 'shop', 'store', 'blog', 'docs', 'test', 'demo', 'staging', 'preview',
]);

const TLD_LIKE = new Set(['com', 'net', 'org', 'io', 'ai', 'co', 'dev', 'app', 'me', 'so', 'sh', 'xyz', 'design', 'studio', 'agency', 'site', 'website', 'page', 'link', 'live', 'us', 'uk', 'de', 'fr', 'nl', 'es', 'it', 'se', 'no', 'fi', 'dk', 'pl', 'ca', 'au', 'nz', 'jp', 'kr', 'cn', 'in', 'br', 'mx', 'ch', 'at', 'be', 'pt', 'ie', 'cz', 'gr', 'ru', 'tr', 'za', 'eu', 'tv', 'fm', 'cc', 'to', 'gg', 'is', 'la', 'ly', 'st', 'am', 'im']);

/** camelCase / kebab / snake / digits -> lowercase parts. */
function parts(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((x) => x.split(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/))
    .map((x) => x.toLowerCase())
    .filter(Boolean);
}

/** The hostname with hosting noise and the public suffix removed: acme-studio.framer.website -> acme-studio */
export function hostBrand(hostname: string): string {
  let h = hostname.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  for (const sfx of PLATFORM_SUFFIXES) if (h.endsWith('.' + sfx)) { h = h.slice(0, -(sfx.length + 1)); return h.split('.').filter(Boolean).pop() || h; }
  const labels = h.split('.').filter(Boolean);
  while (labels.length > 1 && TLD_LIKE.has(labels[labels.length - 1])) labels.pop();
  return labels[labels.length - 1] || h;
}

/**
 * Every word that would identify the origin: the host brand whole, its parts, and any word in the page title
 * that is a spelling of one of them (the title is only used to learn casing and glued forms, never to ban
 * arbitrary tagline words). `extra` is the escape hatch for founder names, product names, anything the
 * hostname does not carry: `1to1 clone <url> --tokens acme,northstar`.
 */
export function originTokens(url: string, title?: string, extra: string[] = []): string[] {
  const brand = hostBrand(new URL(url).hostname);
  const tok = new Set<string>();
  const add = (s: string) => { const v = s.toLowerCase().trim(); if (v.length >= 3 && !GENERIC.has(v) && /[a-z]/.test(v)) tok.add(v); };
  add(new URL(url).hostname.replace(/^www\./, ''));   // the bare hostname is a mention too, wherever it is written
  add(brand);
  add(brand.replace(/[^a-z0-9]+/g, ''));
  for (const p of parts(brand)) add(p);
  const own = [...tok];
  for (const w of parts(title || '')) if (own.some((t) => w === t || w.replace(/s$/, '') === t || t.startsWith(w) || w.startsWith(t))) add(w);
  for (const e of extra) { add(e); for (const p of parts(e)) add(p); }
  return [...tok].sort((a, b) => b.length - a.length);
}

/**
 * Words that are also web vocabulary. A site called Linear must not turn `linear-gradient` into a finding,
 * so a reserved token only matches when it is capitalized: `Linear`, `LinearHero`, `LINEAR` yes, `linear` no.
 */
const RESERVED = new Set([
  'linear', 'ease', 'spring', 'motion', 'frame', 'framer', 'react', 'next', 'node', 'bun', 'vite', 'arc', 'path',
  'wave', 'pulse', 'flow', 'grid', 'flex', 'stack', 'layer', 'block', 'inline', 'card', 'hero', 'nav', 'menu',
  'footer', 'header', 'button', 'input', 'label', 'title', 'link', 'list', 'item', 'form', 'icon', 'logo',
  'image', 'video', 'audio', 'canvas', 'mask', 'blur', 'fill', 'stroke', 'shadow', 'border', 'radius', 'color',
  'font', 'text', 'size', 'space', 'line', 'gap', 'scroll', 'hover', 'focus', 'active', 'view', 'wrap', 'root',
  'base', 'main', 'body', 'head', 'side', 'panel', 'modal', 'sheet', 'tab', 'tabs', 'chip', 'pill', 'badge',
  'hash', 'index', 'range', 'target', 'source', 'asset', 'build', 'style', 'theme', 'token', 'light', 'dark',
  'auto', 'none', 'full', 'half', 'mini', 'macro', 'micro', 'delay', 'offset', 'origin', 'center', 'left',
  'right', 'top', 'bottom', 'start', 'end', 'first', 'last', 'open', 'close', 'load', 'play', 'pause', 'mark',
]);

export function isReservedToken(token: string) { return RESERVED.has(token.toLowerCase()); }

/**
 * Case-shape preserving matcher. Boundaries allow camel glue (AcmeStudio) but not mid-word noise (acmestudio).
 * Reserved tokens are matched case-sensitively so web vocabulary survives.
 */
export function tokenRe(token: string): RegExp {
  const body = token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  // case folded per character rather than with the i flag: the trailing lookahead has to stay lowercase-only,
  // so that `AcmeMark` is a hit (camel glue) while `acmemark` is not (a different word).
  const anyCase = body.replace(/[a-zA-Z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
  if (!RESERVED.has(token.toLowerCase())) return new RegExp(`(?<![A-Za-z0-9])(${anyCase})(?![a-z0-9])`, 'g');
  const Capped = body.replace(/^[a-z]/, (m) => m.toUpperCase());
  return new RegExp(`(?<![A-Za-z0-9])(${Capped}|${body.toUpperCase()})(?![a-z0-9])`, 'g');
}

function matchCase(sample: string, replacement: string): string {
  if (sample === sample.toUpperCase() && sample.length > 1) return replacement.toUpperCase();
  if (sample[0] === sample[0]?.toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement.toLowerCase();
}

/** Replace every origin token with the rebuild's own brand, keeping the case shape of what it replaced. */
export function scrub(text: string, tokens: string[], brand = 'brand'): string {
  let out = text;
  for (const t of tokens) out = out.replace(tokenRe(t), (m) => matchCase(m, brand));
  return out;
}

export function hasToken(text: string, tokens: string[]): string | null {
  for (const t of tokens) if (tokenRe(t).test(text)) return t;
  return null;
}

/** Absolute links back to the origin become route-relative, which is what the rebuild wants anyway. */
export function delink(value: string, host: string): string {
  if (!value) return value;
  try {
    const u = new URL(value, 'https://' + host);
    if (u.hostname.replace(/^www\./, '') !== host.replace(/^www\./, '')) return value;
    return (u.pathname || '/') + u.search + u.hash;
  } catch { return value; }
}

/**
 * Every absolute link back to the origin becomes route-relative, in html, css url() or module source.
 * Subdomains count (`updates.<host>`, `cdn.<host>`): they name the origin just as loudly as the apex does.
 */
export function delinkAll(text: string, host: string): string {
  if (!host) return text;
  const h = host.replace(/^www\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`https?://(?:[A-Za-z0-9-]+\\.)*${h}(/[^\\s"'\`<>)]*)?`, 'gi'), (_m, p) => p || '/');
}

/**
 * Scrub a whole source file (rendered html, a Framer module, a css blob). Origin links go route-relative and
 * origin words become the rebuild's brand. base64 payloads are skipped: a letter run inside one can look like
 * a token and rewriting it would corrupt the asset.
 */
/**
 * A bare hostname is a mention even when it is not a link: plain text, or another service's url with the
 * origin's domain in its path. Rewrite it to the same shape with the brand label swapped in
 * (`framer.com` -> `aurora.com`, `acme.framer.website` -> `aurora.framer.website`), subdomains kept.
 */
export function dehost(text: string, host: string, brand: string): string {
  if (!host) return text;
  const bare = host.replace(/^www\./, '');
  const label = hostBrand(bare).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replacement = bare.replace(new RegExp(`(?<![A-Za-z0-9-])${label}(?![A-Za-z0-9-])`, 'i'), brand.toLowerCase());
  const h = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![A-Za-z0-9-])((?:[A-Za-z0-9-]+\\.)*)${h}(?![A-Za-z0-9-])`, 'gi'), (_m, sub) => sub + replacement);
}

export function scrubSource(text: string, tokens: string[], brand: string, host = ''): string {
  return dehost(delinkAll(text, host), host, brand)
    .split(/(data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/gi)
    .map((chunk, i) => (i % 2 ? chunk : scrub(chunk, tokens, brand)))
    .join('');
}

// ---------------------------------------------------------------- neutral names

/** Reference dir name: structure only, never identity. `/` -> site, `/about` -> site-about. */
export function neutralRefName(url: string, tokens: string[] = []): string {
  const p = new URL(url).pathname.replace(/\/+$/, '').replace(/^\//, '');
  const route = scrub(p, tokens, 'page').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return route ? `site-${route}` : 'site';
}

const BUCKET_PREFIX: Record<string, string> = { images: 'img', videos: 'vid', fonts: 'font', audio: 'audio', data: 'data' };

/** Harvested asset filename: content-addressed, never the origin's own filename. */
export function neutralAssetName(hash: string, ext: string, bucket = 'images'): string {
  const e = ext && !ext.startsWith('.') ? '.' + ext : ext;
  return `${BUCKET_PREFIX[bucket] ?? 'asset'}-${hash}${e || ''}`;
}

// ---------------------------------------------------------------- origin file

export function originPath(refDir: string) { return path.join(refDir, '.origin.json'); }

export function writeOrigin(refDir: string, o: Origin) {
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(originPath(refDir), JSON.stringify(o, null, 2));
}

/** The one place the origin lives. Falls back to a legacy meta.json url so old reference dirs keep working. */
export function readOrigin(refDir: string): Origin | null {
  const f = originPath(refDir);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const meta = path.join(refDir, 'meta.json');
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m.url) return { url: m.url, host: new URL(m.url).hostname, title: m.pageTitle, tokens: originTokens(m.url, m.pageTitle), brand: 'brand', capturedAt: m.capturedAt ?? '' };
  }
  return null;
}

/** Tokens for a reference dir, plus any passed on the command line. Empty list = nothing to blackout. */
export function tokensFor(refDir: string, extra: string[] = []): { tokens: string[]; brand: string; host: string } {
  const o = readOrigin(refDir);
  // re-derive alongside what was stored, so a reference dir captured by an older version still scans correctly
  const tokens = new Set<string>([...(o?.tokens ?? []), ...(o ? originTokens(o.url, o.title) : [])]);
  for (const e of extra) for (const t of originTokens('https://example.com', undefined, [e])) tokens.add(t);
  return { tokens: [...tokens].sort((a, b) => b.length - a.length), brand: o?.brand ?? 'brand', host: o?.host ?? '' };
}

/** The rebuild's own name, derived from the project folder unless told otherwise. */
export function brandFor(projectDir: string, explicit?: string): string {
  const base = explicit ?? path.basename(path.resolve(projectDir));
  const clean = base.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return clean ? clean.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('') : 'Brand';
}

// ---------------------------------------------------------------- leak scan

export type Leak = { file: string; line: number; token: string; kind: 'leak' | 'copy'; text: string };

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.vercel', 'dist', 'build', 'out', 'coverage', '.cache', 'reference', '.claude']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.html', '.svg', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.env', '.sh']);
const CODE_CONTEXT = /\b(import|require|from|href|src|url\(|className|classname|@font-face|fetch|export function|export const|function |const |class |data-|aria-|alt=|id=)/;
const COMMENT = /^\s*(\/\/|\/\*|\*|#|<!--)/;

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, out, depth + 1); continue; }
    out.push(full);
  }
  return out;
}

/**
 * Walk a project and report every surviving mention of the origin. A hit in a path, an import, a comment or
 * an identifier is a `leak` (fails the gate). A hit that is plainly display copy is reported as `copy` so it
 * can be rewritten deliberately; `--strict` promotes those to leaks too.
 */
export function scanLeaks(projectDir: string, tokens: string[], opts: { strict?: boolean; skip?: string[] } = {}): Leak[] {
  if (!tokens.length) return [];
  const skip = new Set([...SKIP_DIRS, ...(opts.skip ?? [])]);
  const leaks: Leak[] = [];
  for (const file of walk(projectDir).filter((f) => !f.split(path.sep).some((s) => skip.has(s)))) {
    const rel = path.relative(projectDir, file);
    const inName = hasToken(rel, tokens);
    if (inName) leaks.push({ file: rel, line: 0, token: inName, kind: 'leak', text: 'file path names the origin' });
    if (!TEXT_EXT.has(path.extname(file))) continue;
    let body: string;
    try { const st = fs.statSync(file); if (st.size > 2_000_000) continue; body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    body.split('\n').forEach((line, i) => {
      const t = hasToken(line, tokens);
      if (!t) return;
      const isCopy = !COMMENT.test(line) && !CODE_CONTEXT.test(line) && /[>"'`]/.test(line);
      leaks.push({ file: rel, line: i + 1, token: t, kind: isCopy && !opts.strict ? 'copy' : 'leak', text: line.trim().slice(0, 160) });
    });
  }
  return leaks;
}

export function printLeaks(leaks: Leak[]): { leaks: number; copy: number } {
  const hard = leaks.filter((l) => l.kind === 'leak');
  const soft = leaks.filter((l) => l.kind === 'copy');
  for (const l of hard) console.log(`  LEAK  ${l.file}${l.line ? ':' + l.line : ''}  "${l.token}"  ${l.text}`);
  for (const l of soft.slice(0, 40)) console.log(`  copy  ${l.file}:${l.line}  "${l.token}"  ${l.text}`);
  if (soft.length > 40) console.log(`  copy  ... ${soft.length - 40} more`);
  return { leaks: hard.length, copy: soft.length };
}
