/**
 * Screenshot a page (yours or the reference) under the same conditions as the capture.
 * Default = revealed scroll-and-stitch full page (2x). Options:
 *   --w 1440 --h 900 --scale 2 --wait 2500 --noreveal
 *   --clip x,y,w,h           region of the full page (css px)
 *   --scrollto <y>           viewport shot at a scroll offset (wheel-driven so Lenis cooperates)
 *   --click <selector> [--nth 0] [--clickwait 1200]   open menus / tabs / accordions before shooting
 *   --hover <selector>       hover an element before shooting
 *   --viewport               plain viewport shot (no stitching)
 *   --bg #ffffff             stitch background
 * usage: 1to1 shot <url> <out.png> [options]
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Args, usage } from '../lib/args.ts';
import { launch, newCtx, load, reveal, stitchFullPage, log } from '../lib/browser.ts';

export async function runShot(argv: string[]) {
  const a = new Args(argv);
  const [url, out] = a.positional;
  if (!url || !out) usage('usage: 1to1 shot <url> <out.png> [--w 1440] [--h 900] [--scale 2] [--clip x,y,w,h] [--scrollto y] [--click sel] [--hover sel] [--noreveal] [--viewport]');
  const W = a.num('w', 1440), H = a.num('h', W < 600 ? 844 : 900), scale = a.num('scale', 2);
  mkdirSync(dirname(out), { recursive: true });
  const browser = await launch(true);
  const ctx = await newCtx(browser, { width: W, height: H }, scale);
  const page = await ctx.newPage();
  await load(page, url, a.num('wait', 2500));
  if (!a.flag('noreveal')) await reveal(page);

  const click = a.str('click');
  if (click) {
    await page.locator(click).nth(a.num('nth', 0)).click();
    await page.waitForTimeout(a.num('clickwait', 1200));
  }
  const hover = a.str('hover');
  if (hover) {
    await page.locator(hover).first().hover();
    await page.waitForTimeout(a.num('hoverwait', 800));
  }
  const scrollto = a.str('scrollto');
  if (scrollto !== undefined) {
    // wheel-drive so a smooth-scroll lib owns the scroll (window.scrollTo fights its target)
    await page.mouse.move(W / 2, H / 2);
    const target = +scrollto;
    let cur = await page.evaluate(() => window.scrollY);
    for (let i = 0; i < 200 && Math.abs(cur - target) > 2; i++) {
      await page.mouse.wheel(0, Math.max(-1500, Math.min(1500, target - cur)));
      await page.waitForTimeout(60);
      cur = await page.evaluate(() => window.scrollY);
    }
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await page.waitForTimeout(a.num('scrollwait', 1500));
    await page.screenshot({ path: out });
    log(`saved ${out} (viewport at scrollY ${await page.evaluate(() => window.scrollY)})`);
    await browser.close();
    return;
  }
  const clip = a.str('clip');
  if (clip) {
    const [x, y, w, h] = clip.split(',').map(Number);
    await page.screenshot({ path: out, fullPage: true, clip: { x, y, width: w, height: h } });
  } else if (a.flag('viewport')) {
    await page.screenshot({ path: out });
  } else {
    await stitchFullPage(page, W, H, out, scale, { chunkWaitMs: a.num('chunkwait', 1300), wheelNudge: true, background: a.str('bg', '#ffffff') });
  }
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  log(`saved ${out} (page height ${height})`);
  await browser.close();
}
