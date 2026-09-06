# Subpage builds

Read `reference/CONVENTIONS.md` first: every rule there applies. This file adds what is specific to routes other than the home page.

## Where things are

| page | route | component (stub exists, overwrite) | reference dir |
|---|---|---|---|
<!-- one row per route, e.g. | Projects | /projects | components/pages/projects.tsx -> ProjectsPage | reference/<name>-projects/ | -->

Each reference dir was produced by `1to1 clone <url>` and holds: `spec/page.txt` (whole page: nav + content + footer; nav and footer are the shared shell, build only the content between them), `capture/<vp>/{full.png,layout.json,sections/}` at 1440 / 1024 / 810 / 390, `motion/framer-appear.json`, `motion/rip.md` (+ `constants.json`), `modules/` (the biggest is the page module), `assets/` (copy needed images to `public/img/<originalName>`), `assets/svg/` (sprite defs: if an id is missing from the project's sprite module, append it; keep existing entries untouched).

## Shell
`components/site-shell.tsx` renders sprite defs, texture, `Navigation`, the page, `Footer` and fixed elements. A page component renders only its content sections, each as `<section>` following the Framer structure (container max-width 1200, paddings from the spec). `?only=1` on a route renders the page without nav / footer for clean shots: `http://localhost:{{PORT}}/projects?only=1`. Route transitions: `app/template.tsx` with the fade from `script_main` (`enter: opacity 0 to 1, tween .2s`).

## Motion for subpages
Mechanisms are in the 1to1 skill `docs/FRAMER.md`. Extract this page's values from its page module (`modules/<biggest>.mjs`; `motion/rip.md` already prints the windows):
- on-mount appears: `motion/framer-appear.json` (keys = `data-framer-appear-id` in the tree; `motion/appear-by-name.json` joins them to names). Wire with `initial` / `animate` + the exact spring.
- scroll "Enter" effects: `__framer__transformTargets` windows; the first target object is the `from` state, `__framer__spring` gives damping / stiffness. Wire with `ScrollReveal` / `useScrollFx` (`FX500` / `FX300` / `FX250`).
- variant switch on scroll: `__framer__targets` + `__framer__threshold` with `useScrollVariant`.
- text effects: `tokenization` windows: per-token blur appear (spring bounce 0, duration .4, 0.05s stagger).
- hover / press: `-hover` variant maps and the component `transition` constants (`motion/constants.json`).
- Filter tabs (CMS listings): find the tab component and the category mapping; `1to1 cms <url> out.json` collects every item with categories across tabs and Load More. Replicate the tab transition and the grid re-layout (`layout` + `AnimatePresence` with the module's constants). Load More: page size per breakpoint is in the page module near the collection query.
- Article / detail pages: parse the SSR html of each detail page into rich HTML (headings, bold, lists, images), not plain text.

## Shared primitives
See CONVENTIONS. If a page uses a card that also lives in a home section, lift it into `components/ui/` and make the home section import it (behaviour identical). Class prefixes per page: <!-- e.g. projects pj-, about ab-, articles ar- / detail ad-, contact ct-, 404 nf- -->.

## Verification
`1to1 shot "http://localhost:{{PORT}}/<route>?only=1" out.png --w 1440` (and 1024 / 810 / 390), `1to1 heights http://localhost:{{PORT}}/<route> <live route>`, `1to1 boxes` vs `1to1 refboxes` for the last pixels, `1to1 verify http://localhost:{{PORT}}/<route> reference/<name>-<route>`. Page height at all four widths must match the capture. `bunx tsc --noEmit -p {{PROJECT}}` must pass. No em dashes anywhere.
