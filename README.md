# 1to1

Clone anything. A CLI plus a Claude Code skill that turns a live website into measured ground truth, drives a section-by-section rebuild, and verifies the result to the pixel at every breakpoint.

It grew out of rebuilding a Framer template (sevora.framer.website, six routes, 15k px of page) in Next.js + motion until every route matched the live site's page height exactly at 1440 / 1024 / 810 / 390, with the real springs, the real scroll-linked reveals, the real WebGL footer shader. This repo is that process, packaged.

## Why not just screenshot and "make it look like this"

Because the model then invents easings, guesses paddings, and uses `whileInView` for effects that are actually scroll-progress-linked springs. Taste evaporates. 1to1 replaces guessing with measurement:

- **layout.json**: every visible element's page rect and layout-deciding computed styles, at four widths. The box truth.
- **spec/page.txt**: the DOM tree with Framer names, appear ids and inline styles, plus every CSS rule for those classes per breakpoint. Copy the numbers.
- **60fps frame sequences**: page load, each section scrolling into view, each interactive element hovered / clicked, self-animating elements (tickers, canvases) with a motion timeline. Compare your build's frames to the reference's at the same time steps.
- **Framer motion rip**: the page module's transition constants and every `__framer__transformTargets` / `tokenization` / `tickerEffect` / `dragTransition` window, so the spec is written from source.
- **verify**: page height, section heights, console errors and pixel diff per width. PASS or FAIL. This is the stopping condition.

## Install

```bash
git clone https://github.com/MatthewKim323/1to1 ~/.claude/skills/1to1
cd ~/.claude/skills/1to1 && bun install
export PATH="$HOME/.claude/skills/1to1/bin:$PATH"
1to1 help
```

Needs [bun](https://bun.sh). Chromium is installed on first run.

## Use

```bash
1to1 clone https://example.framer.website/            # extract + capture + prep + rip -> reference/example/
1to1 clone https://example.framer.website/about --no-frames
1to1 init ~/dev/myrebuild --url https://example.framer.website/ --port 3777

# ... build ...

1to1 verify http://localhost:3777/ reference/example --diff
1to1 heights http://localhost:3777/ https://example.framer.website/
1to1 boxes http://localhost:3777/ 1440 800 1700
1to1 refboxes reference/example desktop 800 1700
```

Full command list: `1to1 help`. As a Claude Code skill: "clone this site 1:1: https://...". The agent reads SKILL.md, runs the pipeline, sets a `/goal`, spawns builders, and verifies until PASS.

## What a reference folder contains

```
reference/<name>/
  REBUILD.md               start here: heights per width, section table, the loop
  meta.json                url, stack, doc heights, counts
  spec/page.txt            DOM tree + CSS per breakpoint     spec/sections/NN-*.txt per section
  dom/full.html tree.txt styles.css
  capture/
    README.md report.json  viewports, sections with y-ranges, scenario table, caveats
    <vp>/full.png layout.json unrevealed.json sections/NN-*.png     vp = desktop | tablet | tablet-810 | mobile
    frames/<scenario>/NNNNN.png frames.json motion-timeline.json  load, scroll-*, hover-*, click-*, loop-*
    assets/
  motion/
    framer-appear.json appear-by-name.json    on-mount springs per element (Framer)
    rip.md constants.json modules.md          ripped from the page modules (Framer)
    observed.md animations.json              what the browser reported (any site)
  modules/*.mjs            the site's own code
  assets/{images,videos,fonts,svg}/ manifest.json
  tokens/                  colors, typography, spacing, css vars
  screenshots/<vp>-full.png
```

## Docs

- [docs/METHOD.md](docs/METHOD.md): the method, step by step, with the reasoning
- [docs/FRAMER.md](docs/FRAMER.md): Framer internals and the gotchas that cost pixels
- [docs/VERIFY.md](docs/VERIFY.md): the verification loop
- [docs/AGENTS.md](docs/AGENTS.md): parallel builders, prompts, failure handling
- [templates/](templates/): CONVENTIONS.md, PAGES.md, GOAL.md, agent prompts

## Limits

- No authenticated sites (no cookie injection).
- Canvas / WebGL is captured as frames and the drawing code is located in the modules; porting it is still your job (the footer shader took reading the runtime's texture loader to get right).
- Sites that gate by user agent or geography may not capture cleanly.
- Frames are recorded at desktop only. Add hover targets with `--hovers file.json` when auto-detection misses a component.

MIT
