# Conventions for section builders

Goal: pixel-and-motion 1:1 rebuild of the captured reference in {{STACK}}, shipped as {{BRAND}}'s own components. Tailwind may be installed; exact values go in inline style objects and scoped `<style>` blocks.

Project: `{{PROJECT}}`. Dev server already running at http://localhost:{{PORT}} (do NOT start another). Reference: `{{REF_ABS}}/`. Rigs: `1to1 <cmd>` (see `1to1 help`).

## Origin blackout (rule zero)
Nothing you write may say where this came from. No origin name, host, brand, logo filename, link or "cloned from / based on / like <site>" anywhere: not in a component, file name, class name, CSS comment, code comment, alt text, page metadata, doc or commit message. These are {{BRAND}}'s components and {{BRAND}}'s assets.
- The reference is already scrubbed for you: the origin's words read as `{{BRAND}}` in `spec/`, `dom/`, `modules/` and the motion docs, and its links are route-relative. Copy text verbatim from `spec/` and you stay clean. Never copy from a live browser tab, and never go looking for the source url (it lives in `{{REF}}/.origin.json` for the rigs only).
- Assets are content addressed (`img-<hash>.webp`, `font-<hash>.woff2`). Keep those names. A logo / wordmark asset still carries the origin visually: use it as a placeholder, name it neutrally (`logo.svg`, `mark.svg`) and say so in your reply.
- `1to1 blackout {{PROJECT}}` must print CLEAN. `1to1 verify` runs it and FAILs on a hit.

## Ground truth (read these, never guess)
- `spec/sections/NN-<section>.txt` (or `spec/page.txt`): the section's DOM tree (`data-framer-name` labels, appear ids, classes, layout inline styles, text) followed by every CSS rule for its classes per breakpoint. `@base` = desktop (>= 1200). `(min-width:810px) and (max-width:1199.98px)` = tablet. `(max-width:809.98px)` = phone. Cascade: apply @base, then override per breakpoint.
- `capture/desktop/sections/NN-*.png` (2x) and `capture/{tablet,tablet-810,mobile}/sections/`: what it must look like, revealed. Elements may be mid-animation; rest state is the target.
- `capture/<vp>/layout.json`: every element's page rect and computed styles. `1to1 refboxes {{REF}} <vp> <y0> <y1>` prints the rows for a y-range; compare with `1to1 boxes http://localhost:{{PORT}}/?only=<section> <width> <y0> <y1>` on your build.
- `motion/component-specs.md` + `motion/transitions.json` (when present): exact transitions per element. Use verbatim. `motion/framer-appear.json`: on-mount appears by appear id.
- `dom/full.html`, `dom/styles.css`: raw material. `1to1 cssq {{REF}} <class>` prints rules for a class.
- `assets/svg/<id>.svg`: sprite defs, available at runtime through the `Sprite` component: `<use href="#id">`. Helpers `Icon` / `SpriteGraphic` set the `--sw` (stroke width) and `--ic` (color) vars. Inline Phosphor icons (viewBox 0 0 256 256, raw `<path>`): copy the path data from `dom/full.html`.
- Images: copy from `assets/images/` to `public/img/<sameName>` (already content addressed, e.g. `img-9f2c1a77b3.webp`) and reference `/img/<sameName>`. Do not rename them after the origin's own filenames.

## Design tokens (app/globals.css)
<!-- fill in after scaffolding: every --token-<uuid> mapped to a named var, e.g. --c-ink #121218, --c-body #44454c, --c-line #c9cdd2, --c-surface #f7f7f8 -->
Fonts: <!-- e.g. var(--font-sans) = Instrument Sans, var(--font-serif) = Lora -->. Map any `--token-<uuid>` in the CSS to the hex fallback written in the same rule.

## Shared primitives (components/ui)
<!-- list what exists: Button variants, IconButton, Pill, SectionHeader, Stat, Icon / SpriteGraphic, Avatar, AccordionItem, ScrollReveal (lib/scroll-reveal.tsx: ScrollReveal, useScrollFx, FX500/300/250), lib/motion.ts (appearSpring, revealSpring, hoverTween) -->
Reuse these; extend backward-compatibly rather than duplicating. New reusable pieces go in components/ui. Re-read a shared file before editing it; another builder may have changed it.

## Component rules
1. One file per section: `components/sections/<name>.tsx`, `"use client"` when it uses motion or hooks, named export `export function <Name>()`.
2. Section root follows the Framer structure: `<section style={{display:'flex', justifyContent:'center', width:'100%'}}><div style={{flex:'1 0 0', width:'100%', maxWidth:1200, padding:'96px 24px', display:'flex', flexDirection:'column', alignItems:'center', gap:64}}>`. Copy exact paddings / gaps / radii / sizes from the spec. Never eyeball a number.
3. Typography: copy `--framer-font-size / line-height / weight / letter-spacing / color` from the matching preset rule. `white-space: pre` becomes `whiteSpace: 'pre'`. Presets change per breakpoint; check tablet and phone rules.
4. Responsive: desktop-first inline styles, overrides in a `<style>` block scoped by a unique class prefix (yours: `{{PREFIX}}-`; grep before choosing another) at `@media (max-width:1199.98px)` and `@media (max-width:809.98px)`. Nodes with `hidden-<hash>` classes are hidden at that breakpoint.
5. Motion: `motion` components (`import { motion } from "motion/react"`). Before the spec exists: use `revealSpring` and leave `// TODO(spec)` on every guessed value. After: exact values from component-specs.md. Framer "Enter" effects (scroll transform) are scroll-progress-linked springs through `ScrollReveal` / `useScrollFx`, never `whileInView`.
6. Framer `data-border` borders are overlays: `boxShadow: 'inset 0 0 0 1px <color>'` or an absolutely positioned inset span with `border`, `borderRadius: 'inherit'`, `pointerEvents: 'none'`. Never a real CSS border (adds 2px to the box).
7. Framer's `flex: 1 0 0; width: 1px` fill idiom only works in a flex row; in column contexts use `width: '100%'`.
8. Masks: `-webkit-mask` becomes `WebkitMaskImage` + `maskImage`.
9. Text content verbatim from the tree, including typographic apostrophes. The tree is already scrubbed, so where it says `{{BRAND}}` that is the copy: keep it. No em dashes anywhere (code, comments, copy you write).
10. After writing, screenshot: `1to1 shot "http://localhost:{{PORT}}/?only=<name>" {{REF}}/build/<name>-1440.png --w 1440`. Compare with the reference crop using the Read tool; fix spacing, sizes, fonts, colors, positions; repeat. Then `--w 1024`, `--w 810`, `--w 390` against the tablet / phone crops. Section height must equal the reference at every width (`1to1 heights`).
11. Do not touch other sections' files, `app/layout.tsx` or `globals.css`. Register your section in `app/page.tsx` only in the marked slot.
12. `bunx tsc --noEmit -p {{PROJECT}}` must pass for your file. Check the dev log for runtime errors from your component.
13. Before you report done: `1to1 blackout {{PROJECT}}` prints CLEAN. If it names your file, rename the identifier or drop the comment; `--fix` rewrites text hits to `{{BRAND}}`.
