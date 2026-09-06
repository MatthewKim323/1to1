# Framer internals

What a Framer export actually is, and how to read it. Source of truth for every statement: the page module, `shared-lib.*.mjs`, `script_main.*.mjs`, `framer.*.mjs` (the runtime) and `dom/full.html` of a real site.

## Anatomy of the export

- `dom/full.html`: SSR markup. Every node carries `class="framer-<scope> framer-<hash>"`, many carry `data-framer-name` (the layer name from the editor: use it, it is how humans think about the page), some carry `data-framer-appear-id` (on-mount animation). Inline styles carry the instance overrides (`--framer-font-size`, `--border-color`, `opacity: 0.001` before appear). A `<script type="framer/appear" id="__framer__appearAnimationsContent">` holds the appear animations as JSON keyed by appear id then breakpoint hash.
- `<style>` blocks: one per component scope. Rules are per class and per breakpoint: `@base` (desktop, `min-width:1200px`), `@media (min-width:810px) and (max-width:1199.98px)` (tablet), `@media (max-width:809.98px)` (phone). `hidden-<hash>` classes hide a node at one breakpoint. `prep` groups every rule for the classes in the tree into `spec/page.txt`.
- `modules/*.mjs` from framerusercontent.com: the page module (largest, contains every section as JSX-ish code plus inlined sub-components), `shared-lib` (components shared with the layout template: Brand, Button, Nav, Menu), `script_main` (the `Main` layout template: nav instance, page slot, footer, route transition), CMS collection modules (schema + data, or a binary dataset), code components (stylokit AnimatedNumber, ScrollProgressLine, Ticker), text style presets, then the runtime (`framer.*.mjs`), `motion.*.mjs`, `react.*.mjs`.
- Strings in the modules are backtick-quoted: `type:\`spring\``, `displayName=\`Elements/Button\``. Grep accordingly.
- A single inline `<svg>` sprite of `<symbol id=...>` defs is recolored through two CSS vars on the `<use>` parent: `--sw` (stroke width) and `--ic` (color). `prep` writes each def to `assets/svg/<id>.svg`. Phosphor icons appear as raw `<path>` with viewBox 0 0 256 256: copy the path data.
- Images: framerusercontent URLs with `?scale-down-to=` variants and `srcset`. Take the largest.
- Tokens: `--token-<uuid>` custom properties. Every use carries the fallback: `var(--token-9eeddc74-..., rgb(18, 18, 24))`. Map uuid to value once.

## Breakpoints

desktop `>= 1200`, tablet `810 to 1199.98`, phone `< 810`. Capture at 1440, 1024, 810 (tablet at both edges: layouts that depend on `vw` or wrap differently show up), 390. An extractor "tablet" screenshot at 768px is the phone layout. Cascade: base rule, then tablet override, then phone override. When phone looks wrong check for a tablet media block whose upper bound is missing (leaks into phone).

## The five motion mechanisms

1. **SSR appear (on mount)**: `data-framer-appear-id`. Values in `framer-appear.json`: `{ initial, animate: { ..., transition } }` per breakpoint key (desktop / tablet / phone hashes, often identical; `default: null` means not animated on desktop). Runtime pre-samples the spring into WAAPI keyframes (`startOptimizedAppearAnimation`), which is why CDP reports them as linear WebAnimations. Rebuild: `initial` / `animate` with the listed transition, e.g. `{type:'spring', bounce:0.2, duration:0.4, delay:0.4}`. `rip` joins ids to element names in `appear-by-name.json`.

2. **Scroll transform, the "Enter" effect**: props `__framer__transformTargets:[{target:{opacity:0,y:96,...}}, {target:{opacity:1,y:0,...}}]`, `__framer__transformTrigger:'onInView'`, `__framer__spring:{damping:60, stiffness:500|300|250, mass:1, ...}`. Runtime: `scroll(cb, {target: el, offset:['start end','end end']})`, progress 0 to 1 mapped per property from target[0] to target[1], each value then chased by a spring. Scroll-progress-linked, reversible, replays every pass. **Not `whileInView`.** Rebuild:
   ```tsx
   const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] });
   const y = useSpring(useTransform(scrollYProgress, [0, 1], [96, 0]), { damping: 60, stiffness: 500, mass: 1 });
   const opacity = useSpring(useTransform(scrollYProgress, [0, 1], [0, 1]), { damping: 60, stiffness: 500, mass: 1 });
   ```
   motion ignores `duration` / `ease` when stiffness is present. Add `style={{ transformPerspective: 1200 }}` only where a 3D target exists.

3. **Scroll target**: `__framer__transformTrigger:'onScrollTarget'` with a `ref` to a marker element (`__framer__transformViewportThreshold`). Input range = `[offsetTop(marker) - 1, + marker height]` of `scrollY`, output = the two targets. Used for the fixed nav that slides in after scrolling ~150px. Rebuild: `useSpring(useTransform(scrollY, [147, 179], [0, 84]), spring)`.

4. **Variant switch on scroll**: `__framer__variantAppearEffectEnabled`, `__framer__targets:[{ref, target: variantId}]`, `__framer__threshold`, `__framer__animateOnce:false`. Runtime builds ranges `top = offsetTop(ref) - 1 - threshold * vh`, `bottom = top + ref.clientHeight`, maps `scrollY` to a variant id, `'initial'` outside all ranges; `animateOnce:false` flips back. Used for process timelines (active step) and tab panels that switch by scroll (desktop only).

5. **Text effect**: `effect:{type:'appear', tokenization:'character'|'word'|'line', effect:{filter:'blur(10px)', opacity:.001, y:10, ...}, transition:{type:'spring', bounce:0, delay:.05, duration:.4}, trigger:'onMount'|'onInView' (threshold .5), repeat}`. Runtime splits into inline-block spans and animates with `stagger(0.05)`. Rebuild: per token spans, spring bounce 0 duration 0.4, 0.05s stagger, `repeat` = replay on every entry.

Plus gestures: components carry variant maps (`-hover`, pressed) and one `transition` constant each. Hover values are in the module's `addPropertyOverrides` / variant style maps; hover of a Button animates a two-stop gradient and inset shadows. Drag: `drag`, `dragSnapToOrigin`, `dragTransition:{bounceDamping:30, bounceStiffness:400}`.

### Transition constants seen in the wild
`{type:'spring', bounce:.2, duration:.4}` (most components), `{type:'spring', damping:60, stiffness:500, mass:1}` (nav pieces), `{damping:60, stiffness:600}` (accordion), `{type:'tween', duration:.4, ease:[0,0,1,1]}` (tabs, linear), `{damping:30, stiffness:400, delay:.2}` (nav fade), `{type:'tween', duration:0}` (instant step icon), count-ups `{damping:30, stiffness:100}`. Route transition in `script_main`: `enter:{opacity:0 to 1, tween .2s ease [.27,0,.51,1]}`. `rip` lists the actual constants of your site in `motion/constants.json`; always use those.

## Reading the modules

- `1to1 rip <ref>` writes `motion/rip.md` with windows around each pattern and `modules.md` with scope classes and display names per module. Start there.
- To go deeper: `python3 -c "s=open('modules/<page>.mjs').read(); import re; [print(s[m.start()-600:m.end()+600], '\n----') for m in re.finditer(r'tickerEffect', s)]"`. The main module is one line; always print windows.
- Ticker: `tickerEffectSpeed`, `tickerEffectDirection`, `tickerEffectGap`, `tickerEffectHoverFactor`, `tickerEffectFadeOptions`, `tickerEffectAlignment`. Speed maps to px/s in the runtime (grep `tickerEffect` there). Measure the result: transform delta over 2s on the rendered ticker.
- CMS: collection modules export the schema and either inline items or a dataset URL. When the data is binary, scrape the listing with `1to1 cms` (clicks every tab and Load More). Page size per breakpoint lives in the page module near the collection query.
- Canvas / WebGL: find `getContext` or `fragmentShader` windows. Framer's Shader component ("Logo Spectrum" and friends) rasterizes SVG textures to a 4096px max side before building a heightmap; matching that raster size is what makes the shader look right. Copy the GLSL and every uniform value verbatim.
- Code components (stylokit etc.) export plain React with prop defaults; port them, do not approximate.

## Gotchas that cost pixels

- **Overlay borders.** `data-border="true"` + `--border-color` + `--border-*-width` draw the border as an absolutely positioned inset pseudo element. A real CSS border adds its width to the box (2px per element vertically) and broke six section heights across two pages. Use `box-shadow: inset 0 0 0 1px <color>` or an inset span with `border-radius: inherit; pointer-events: none`.
- **`flex: 1 0 0; width: 1px`.** Framer's fill idiom. Works only inside a flex row; when a breakpoint switches the parent to column the 1px width is literal and the element collapses. Replace with `width: 100%` in column contexts.
- **Tablet blocks leaking into phone.** A rule written for `max-width: 1199.98px` also applies below 810 unless the phone block overrides it. Check the phone spec explicitly.
- **`hidden-<hash>`.** Nodes hidden per breakpoint; a tag row or a second image instance may exist only at tablet. The tree shows them; the phone screenshot does not.
- **Instance overrides beat component CSS.** A card whose component says `height: min-content` can carry `height: 100%` inline on the instance, equalizing grid rows. Read the inline style in the tree, not just the class rule.
- **Presets per breakpoint.** Heading presets change size at tablet and phone (36/48 to 24/32 etc.); `max-width` on a title (320px) forces the two-line wrap the reference has.
- **Static stagger via `position: relative; top`**, not `margin-top` (margins inflate grid tracks).
- **Rich text.** Article bodies have h3 / strong / lists with their own margins; storing them as plain paragraphs loses hundreds of px.
- **Nested `main` gaps.** A wrapper `gap` between body and a "related" block that does not exist live.
- **Sticky sections in stitched captures** repeat per chunk; use the scroll frames for their truth.
- **Mid-spring captures.** A reference crop may catch an element mid-animation; rest state is the target. `layout.json` is taken after the reveal settles.
- **Lenis** overrides `window.scrollTo` targets; rigs detect this and drive scroll with wheel events. Scroll-linked effects computed from `scrollY` work under Lenis.
