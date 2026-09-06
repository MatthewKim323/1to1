# Verification

The reference is measured. The build is measured the same way. 1:1 means the numbers match.

## The gate

```bash
1to1 verify http://localhost:3777/<route> reference/<name> --diff
```

Per width (1440 / 1024 / 810 / 390, whatever the capture has):

| check | source | rule |
|---|---|---|
| page height | `capture/report.json` viewports.docHeight vs the build after a reveal pass | equal (`--tolerance 0`) |
| section heights | `capture/report.json` sections vs the build's outermost `section` / `footer` / `header` elements, matched by order | every one equal |
| console | errors + pageerrors while scrolling the build | zero |
| pixel diff (`--diff`) | stitched build full page vs `capture/<vp>/full.png`, per section | reported, not gating: text antialiasing, mid-spring captures and animated textures make a few % normal |

Exit code 1 on FAIL. `build/verify.json` has the numbers. The `/goal` condition points at this: PASS for every route at every width.

Wrap every top-level block of your page in a `<section>` (footer in `<footer>`) so section matching by order works.

## Finding a delta

1. `1to1 heights <dev route> <live route>`: page and section heights side by side at every width, `<-- differs` where they do not. Tells you the section.
2. `1to1 refboxes reference/<name> <vp> <y0> <y1>` and `1to1 boxes <dev route> <width> <y0> <y1>` over that section's y-range: same columns (y, x, w, h, tag, framer name, own text, padding, gap, flex direction, font-size / line-height). Read them top down; the first row whose y or h differs is the element. Its padding / gap / font columns usually say why.
3. `1to1 cssq reference/<name> <class>` for the reference rule per breakpoint when the spec slice is not enough.
4. Fix the box model, re-run heights. Repeat. Common causes are in FRAMER.md §Gotchas.

For visual checks, `1to1 shot <dev route>?only=<section> out.png --w 1440` then Read the crop next to `capture/desktop/sections/NN-*.png`. `1to1 diff build.png ref.png outDir --ref reference/<name>` writes build | reference | mask sheets per section and prints % differing.

## Motion

Values come from source; frames verify timing.

- Load: `1to1 frames <dev> build/frames/load --ms 6000 --start-before-nav`, then `1to1 sheet build/frames/load a.png --step 250` and the same on `capture/frames/load`. Elements must appear in the same order in the same 250ms windows (card, nav, characters, buttons, stats, ticker on the sevora hero).
- Section scroll: read `scrollFrom` / `scrollTo` from `capture/frames/scroll-<section>/frames.json`, then `1to1 frames <dev> out --scroll <from>,<to>,1500 --ms 4000` and sheet both.
- Hover / click: `--hover <selector>` / `--click <selector>`; compare `marksMs` and the motion ranges in both `motion-timeline.json`.
- Loops: `capture/frames/loop-*/motion-timeline.json` has `hoverAnalysis.verdict` (PAUSES / SLOWS / no change on hover). Match it. Measure a ticker's px/s on the build by sampling its transform over 2s.
- Scroll-linked reveals: `1to1 shot <dev> out.png --scrollto <y>` at two or three offsets; elements must sit between their `from` and rest values, and scrolling back up must reverse them.

## Before calling it done

```bash
bunx tsc --noEmit
bun run build              # or next build
1to1 console http://localhost:3777 /,/about,/projects,/articles,/contact,/missing
1to1 verify http://localhost:3777/ reference/<home> --diff      # and every other route
```

Report the table. Say what was frame-verified, what was only height-verified, what was not checked.
