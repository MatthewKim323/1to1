# The method

Everything here was learned rebuilding a six-route Framer site to the pixel in one day. The order matters; the reasons are written down so the steps do not degrade into ritual.

## 0. Decide what 1:1 means, then lock it

"Looks the same" is not a stopping condition; an agent will call it done after the hero. The condition that worked:

- page height of every route equals the live site at 1440 / 1024 / 810 / 390 (Framer's three breakpoints, tablet sampled at both edges)
- every top-level section height equals the live site at every width
- motion values come from source, and load / scroll / hover timing lines up frame by frame with the reference
- `tsc` clean, production build green, zero console errors on every route

Set it as a Claude Code goal (`/goal ...`, text in `templates/GOAL.md`) before starting. The stop hook keeps the session working until `1to1 verify` says PASS.

## 1. Extract the truth (`1to1 clone <url>`)

Four things have to be true of a reference or the rebuild will be wrong in ways you cannot see:

1. **Revealed.** Scroll-triggered appears leave elements at opacity 0 until they enter the viewport. A naive full-page screenshot is mostly blank. The rig scrolls top to bottom in 250px steps (wheel events when Lenis owns the scroll), waits, verifies every `data-framer-appear-id` element reached opacity 1, then screenshots.
2. **Real viewport.** Playwright `fullPage` uses captureBeyondViewport, which resizes the viewport to the document height. `vh` sections re-lay-out and IntersectionObservers fire; a 13573px page measured 10900 that way. The rig takes viewport-sized chunks at each scroll offset and stitches them, hiding fixed elements after the first chunk.
3. **Boxes, not pixels.** `layout.json` records every visible element's page rect and the computed styles that decide layout (display, flex, gap, padding, margin, font, line-height, border, radius, transform). Screenshots tell you something is off; layout.json tells you which element by how many pixels.
4. **Frames, not video.** CDP `Page.startScreencast` emits every compositor frame with its swap timestamp. Scenarios: fresh load (screencast starts before navigation), each section scrolled from 85% to 15% of the viewport over 1.5s on a fresh page (so appears replay), each interactive element hovered / clicked with the mouse moved in steps, self-animating elements for 4s then hovered (pauses? slows?). A per-frame diff gives the motion timeline in ms. Gaps between frames mean nothing repainted.

Then `prep` turns `dom/full.html` into `spec/page.txt`: the tree with Framer names, appear ids, classes, layout inline styles and text, followed by every CSS rule for those classes grouped by breakpoint. Builders copy numbers from this file. `rip` (Framer) prints windows around every motion pattern in the page modules and lists the transition constants. `REBUILD.md` ties it together.

Run `clone` for every route in the nav. Frames matter on the home page; subpages usually only need `--no-frames`.

Look at the captures yourself before writing code: slice `capture/desktop/full.png` into 2000px chunks and Read them. Know what the page is, what is animated (gifs, canvases, tickers, shaders), what the nav does at each width (open the mobile menu with `1to1 shot ... --click`).

## 2. Scaffold and rulebook

Scaffold the app (Next.js App Router + React 19 + `motion` + Lenis worked; Tailwind installed but exact values go in inline style objects and scoped `<style>` blocks). Then, before any builder runs:

- **Tokens**: map every `--token-<uuid>` in the CSS to its hex fallback (the fallback is in the rule) and name them once in globals.css. Fonts: read the `@font-face` blocks and the presets; self-host or load from Google as the site does.
- **Shared primitives**: Button (all variants, hover gradients, the gif texture layer), IconButton, Pill, SectionHeader, Stat count-up, Icon/Sprite (Framer inlines one `<svg>` sprite of `<symbol>` defs recolored via `--sw` / `--ic` vars; `prep` extracts them to `assets/svg/`). Builders reuse, never duplicate.
- **Nav + hero** yourself. They set the shared vocabulary and you learn the site's idioms (overlay borders, `flex:1 0 0; width:1`, hidden-per-breakpoint classes) before delegating.
- **`?only=<section>`** query on the page: renders one section without the shell. Every screenshot in the loop uses it.
- **`1to1 init <project> --url <url>`** writes `reference/CONVENTIONS.md` (the builder contract) and `reference/PAGES.md` (subpage rules). Fill CONVENTIONS with the real tokens, fonts and primitive names. It is the most leveraged file in the job: every mistake it prevents is prevented ten times.

## 3. Motion spec from source (Framer)

One agent, prompt in `templates/prompts/motion-ripper.md`, reads the page module (one giant line; python regex windows) and writes `motion/component-specs.md` + `transitions.json`: for every element, mechanism, initial / animate / transition, hover and press variants, ticker props with the computed px/s, scroll-linked effects with their springs, text effects, loops, canvas drawing code. Quoted, never rounded. `docs/FRAMER.md` describes the five mechanisms it must classify and how the runtime interprets them.

This runs in parallel with the layout builders. Layout first, motion second, because motion attaches to boxes that must already be right.

## 4. Layout builders in parallel

One agent per section (`templates/prompts/section-builder.md`), all at once. Each gets: CONVENTIONS, its `spec/sections/NN-*.txt`, its crops at three widths, `layout.json`, the y-range of its section on the live page, and the instruction to screenshot with `1to1 shot "<dev>/?only=<name>"` and compare with the Read tool until it matches at 1440, then 1024, then 390. Rules that saved the most time:

- one file per section, scoped CSS with a unique class prefix (grep first)
- copy paddings / gaps / radii / sizes / typography from the spec; never eyeball
- Framer `data-border` borders are overlays: inset box-shadow or an absolutely positioned inset span, never a real border (adds 2px, breaks heights)
- desktop-first inline styles, overrides at `max-width:1199.98px` and `max-width:809.98px`
- do not touch other sections, layout.tsx or globals.css

Ten builders finished a home page in about 15 minutes wall clock. Integrate as they report: measure section heights against the capture (`1to1 heights`), bisect leaks when a section is wrong only on the full page (a class-prefix collision between two sections once shifted a third).

## 5. Motion pass

Three sections per agent (`templates/prompts/motion-pass.md`) once the spec exists. They replace every `// TODO(spec)` with the real value. The rule they most often get wrong: Framer "Enter" effects (`__framer__transformTargets`) are scroll-progress-linked (`useScroll` offset `['start end','end end']`, `useTransform`, `useSpring` with the listed damping / stiffness), reversible, replayed on every pass. Not `whileInView`. Give them a shared `ScrollReveal` primitive and forbid `whileInView` for that mechanism.

Verify motion with frames: `1to1 frames <dev> out/load --ms 6000 --start-before-nav`, then `1to1 sheet` on both the build's and the reference's `load` frames at the same 250ms steps, side by side. Same for a section scroll (`--scroll from,to,1500`) and the mobile menu (`--click`). Elements must land in the same order in the same window.

## 6. Verify until PASS (`docs/VERIFY.md`)

`1to1 verify <dev> reference/<name> --diff` per route. When a height differs: `1to1 heights` to find the section, `1to1 boxes` vs `1to1 refboxes` on that y-range to find the element, fix the box model, re-measure. Every remaining pixel in the sevora job was found this way; screenshots alone never got the last 30px.

## 7. Subpages

Same loop per route, one page builder each (`templates/prompts/page-builder.md`), with a shared shell (nav + footer + route fade) built first. CMS listings: `1to1 cms <url> out.json` clicks every tab and Load More to collect the full item set with categories; page sizes per breakpoint are in the page module (grep `pageSize` / the collection query). Article bodies: parse the SSR html of each detail page into rich HTML (headings, bold, lists), not plain text; four of nine article pages were short until that was done.

## 8. Report honestly

What matches (table of heights per route per width), what motion was verified frame by frame, what was only height-checked, what was not checked at all, what links out. Nothing is committed unless asked.
