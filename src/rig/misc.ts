/**
 * console: load routes, scroll through, report console errors / warnings / page errors.
 *   1to1 console <base> [/route1,/route2,...] [--w 1440]
 *
 * cms: scrape a Framer CMS listing (tabs + Load More) into JSON: every card with title / href / img / categories.
 *   1to1 cms <url> <out.json> [--cards 'a[href]:has(img)'] [--title 'h3,h4,h5,h6'] [--tabs '[data-framer-name="Tabs"] a'] [--more 'Load More']
 *
 * cssq: print every CSS rule (per breakpoint) whose selector mentions any of the given class fragments.
 *   1to1 cssq <reference/name> <class> [<class2> ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Args, usage } from '../lib/args.ts';
import { launch, newCtx, viewportByWidth } from '../lib/browser.ts';
import { cssBlocks } from '../lib/css.ts';

export async function runConsole(argv: string[]) {
  const a = new Args(argv);
  const base = a.positional[0];
  if (!base) usage('usage: 1to1 console <base-url> [/a,/b,/c] [--w 1440]');
  const routes = a.positional[1] ? a.positional[1].split(',') : ['/'];
  const browser = await launch(true);
  let total = 0;
  for (const r of routes) {
    const ctx = await newCtx(browser, viewportByWidth(a.num('w', 1440)), 1);
    const page = await ctx.newPage();
    const msgs: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => msgs.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on('requestfailed', (q) => { if (!/analytics|events\./.test(q.url())) msgs.push(`requestfailed: ${q.url().slice(0, 160)}`); });
    const resp = await page.goto(base.replace(/\/$/, '') + r, { waitUntil: 'networkidle' }).catch(() => null);
    await page.waitForTimeout(1500);
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(60); }
    await page.waitForTimeout(800);
    const uniq = [...new Set(msgs)].filter((m) => !m.includes('GPU stall'));
    total += uniq.length;
    console.log(`${r} -> ${resp?.status() ?? 'ERR'} · ${uniq.length} console issues`);
    for (const m of uniq.slice(0, 8)) console.log('   ', m);
    await ctx.close();
  }
  await browser.close();
  if (total) process.exitCode = 1;
}

export async function runCms(argv: string[]) {
  const a = new Args(argv);
  const [url, out] = a.positional;
  if (!url || !out) usage("usage: 1to1 cms <url> <out.json> [--cards sel] [--title sel] [--tabs sel] [--more 'Load More']");
  const cardSel = a.str('cards', 'a[href]:has(img)'), titleSel = a.str('title', 'h2,h3,h4,h5,h6'), tabSel = a.str('tabs', '[data-framer-name*="Tabs"] a, [role="tablist"] [role="tab"]'), moreText = a.str('more', 'Load More');
  const browser = await launch(true);
  const ctx = await newCtx(browser, viewportByWidth(1440), 1);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const tabs = page.locator(tabSel);
  const tabCount = await tabs.count();
  const result: any = { url, tabs: [], items: [] };
  const seen = new Map<string, any>();
  const collect = async (label: string, t: number) => {
    for (let i = 0; i < 30; i++) {
      const btn = page.locator(`button:has-text("${moreText}"), a:has-text("${moreText}")`).first();
      if (!(await btn.count()) || !(await btn.isVisible())) break;
      await btn.click();
      await page.waitForTimeout(1200);
    }
    const cards = await page.evaluate(({ cardSel, titleSel }) => Array.from(document.querySelectorAll(cardSel)).map((el) => {
      const img = el.querySelector('img');
      const meta = Array.from(el.querySelectorAll('p, h6, span')).map((n) => (n as HTMLElement).innerText.trim()).filter(Boolean).slice(0, 8);
      return { title: (el.querySelector(titleSel) as HTMLElement | null)?.innerText.trim() ?? '', href: el.getAttribute('href') ?? '', img: img?.getAttribute('src') ?? '', imgW: img?.getAttribute('width') ?? '', imgH: img?.getAttribute('height') ?? '', meta };
    }), { cardSel, titleSel });
    result.tabs.push({ label, count: cards.length, titles: cards.map((c: any) => c.title) });
    for (const c of cards) {
      const key = c.href || c.title;
      if (!seen.has(key)) seen.set(key, { ...c, categories: [] });
      if (t > 0) seen.get(key).categories.push(label);
    }
    console.log(`tab "${label}": ${cards.length} cards`);
  };
  if (tabCount) {
    for (let t = 0; t < tabCount; t++) {
      const tab = tabs.nth(t);
      const label = (await tab.innerText()).trim();
      await tab.click();
      await page.waitForTimeout(800);
      await collect(label, t);
    }
  } else await collect('all', 0);
  result.items = Array.from(seen.values());
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`saved ${seen.size} items -> ${out}`);
  await browser.close();
}

export function runCssq(argv: string[]) {
  const a = new Args(argv);
  const [root, ...qs] = a.positional;
  if (!root || !qs.length) usage('usage: 1to1 cssq <reference/name> <classFragment> [...]');
  const file = fs.existsSync(path.join(root, 'dom', 'styles.css')) ? path.join(root, 'dom', 'styles.css') : root;
  const css = fs.readFileSync(file, 'utf8');
  for (const r of cssBlocks(css)) if (qs.some((q) => r.selector.includes(q))) console.log(`${(r.media || '@base').padEnd(45)} ${r.selector}\n    ${r.body}`);
}
