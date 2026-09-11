---
name: 1to1
version: 1.1.0
description: |
  Clone any deployed website 1:1 (pixel and motion), not "inspired by". Extract the live page into
  ground truth (DOM + per-breakpoint CSS, revealed layouts with every element's box at 1440/1024/810/390,
  60fps frame sequences of load / scroll / hover / loops, Framer motion internals ripped from the page
  modules), rebuild it section by section with parallel builders under a strict rulebook, and verify
  with a box-diff loop until page heights match the live site to the pixel at every breakpoint. Everything it
  produces is origin-blind: the source is never named in the rebuild, only in one local .origin.json.
  Successor to extract-site. Use when asked to "clone this site", "1:1 rebuild", "recreate this framer
  site", "boil the ocean on this page", "make it pixel perfect", "rip the motion from", "extract this site".
triggers:
  - clone this site
  - 1:1 rebuild
  - pixel perfect rebuild
  - recreate this framer site
  - extract this site
  - rip the motion from
  - boil the ocean
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Agent
  - AskUserQuestion
---

# 1to1

Point it at a URL. Get a `reference/<name>/` folder that is the measured truth of the live page. Build from it. Verify against it until `1to1 verify` says PASS at every width. That is the whole skill; everything below is how.

**Rule zero: origin blackout.** What comes out is the user's own site: their components, their assets. It never says where it came from. No origin name, host, brand, logo filename, link or "cloned from / based on / like <site>" in a component, file name, class name, comment, alt text, page metadata, README, reply or commit message. The tool enforces this, not just the prose: reference dirs are named `site` / `site-about`, assets are content addressed (`img-<hash>.webp`), the spec trees / dom / modules are scrubbed at extraction (origin words read as the project's brand, origin links go route-relative), and the source url lives only in `reference/<name>/.origin.json`, which `1to1 init` gitignores. `1to1 blackout <project>` is the scanner and `1to1 verify` fails on a hit. Do not defeat it: never paste the url into code or docs, never open the live page in a browser to copy copy, and never tell a builder agent what the site is.

## Setup (idempotent)

```bash
cd ~/.claude/skills/1to1 && [ -d node_modules ] || bun install
export PATH="$HOME/.claude/skills/1to1/bin:$PATH"   # or call bin/1to1 by path
1to1 help
```

The shim installs the matching Chromium on first run.

## The flow (read docs/METHOD.md once, then follow this)

### 0. Lock the goal
Before anything else, when the user wants 1:1, set a session goal so you cannot stop early:

```
/goal <the text in templates/GOAL.md, with the brand, project and routes filled in; never the source url>
```

The condition is objective: `1to1 verify` PASS for every route at 1440 / 1024 / 810 / 390, `tsc` clean, `next build` green, console clean. Not "looks close".

### 1. Extract + capture + prep + rip (one command)
```bash
cd <project>
1to1 clone <url> --brand Aurora        # headed browser so the user can watch; --headless in CI
1to1 clone <url>/about --no-frames     # every route in the nav; frames are only needed where motion matters
```
`--brand` names the rebuild (default: the project folder name); it is what the origin's words are rewritten to. `--tokens a,b` adds anything the hostname does not carry (a founder's name, a product name). Produces `reference/site[-route]/`: `spec/page.txt` (tree + CSS per breakpoint), `capture/<vp>/layout.json` (every element's box), `capture/<vp>/full.png` + section crops, `capture/frames/*` (60fps), `motion/framer-appear.json`, `motion/rip.md` + `constants.json`, `modules/`, `assets/`, `REBUILD.md`. Read `REBUILD.md` and `capture/README.md` first. Then look at the full-page screenshots yourself (slice them into 2000px chunks and Read them) before writing any code: you need to know what the page is.

### 2. Rulebook into the project
```bash
1to1 init <project> --brand Aurora --port 3777
```
Writes `reference/CONVENTIONS.md`, `reference/PAGES.md`, `reference/GOAL.md` from the templates. Edit CONVENTIONS with the project's real tokens, fonts and shared primitives once the scaffold exists (see docs/METHOD.md §2). Every builder agent reads CONVENTIONS first; it is the contract.

### 3. Motion spec (Framer sites)
Spawn one agent with `templates/prompts/motion-ripper.md`. Input: `modules/`, `motion/rip.md`, `motion/constants.json`, `motion/framer-appear.json`, `dom/full.html`. Output: `motion/component-specs.md` + `motion/transitions.json`: every appear / hover / scroll / text / ticker / loop value, quoted from source, never rounded. docs/FRAMER.md explains the five mechanisms it must classify. Run this in parallel with step 4 layout work; the motion pass (step 5) waits for it.

### 4. Build layout, in parallel, one agent per section
Scaffold the app yourself (tokens, fonts, Lenis, texture, shared primitives: Button, Pill, SectionHeader, Icon/Sprite, Stat) and nav + hero, so the shared vocabulary exists before builders start. Then spawn one builder per section with `templates/prompts/section-builder.md` (or `page-builder.md` per route). Each builder: reads CONVENTIONS + its `spec/sections/NN-*.txt` + its crop + `layout.json`, builds, screenshots with `1to1 shot "<dev>/?only=<section>"`, compares, repeats at 1440 / 1024 / 390. They must not touch other sections' files.

### 5. Motion pass
When the spec lands, spawn motion-pass agents (3 sections each) with `templates/prompts/motion-pass.md`. Key rule they must obey: Framer scroll "Enter" effects are scroll-progress-linked springs, reversible, not `whileInView`.

### 6. Verify until PASS (docs/VERIFY.md)
```bash
1to1 verify http://localhost:3777/ reference/<name> --diff        # per width: page height, section heights, console, pixel diff
1to1 heights http://localhost:3777/ "$(1to1 origin reference/site --url)"   # side by side, all widths
1to1 boxes http://localhost:3777/ 1440 <y0> <y1>                   # your boxes for a y-range
1to1 refboxes reference/<name> desktop <y0> <y1>                   # reference boxes, same columns: the last px lives here
1to1 frames http://localhost:3777/ reference/<name>/build/frames/load --ms 6000 --start-before-nav
1to1 sheet reference/<name>/build/frames/load a.png && 1to1 sheet reference/<name>/capture/frames/load b.png   # compare timing
1to1 console http://localhost:3777 /,/about,/projects
1to1 blackout .                                                    # nothing in the project names the origin (--fix rewrites text hits)
```
A height delta is never "close enough". Find the element with `boxes` vs `refboxes`, fix the box model, re-measure. The recurring causes are listed in docs/FRAMER.md §Gotchas (overlay borders, `width:1` idiom, tablet rules leaking into phone, hidden-per-breakpoint nodes, rich text margins).

### 7. Ship
`bunx tsc --noEmit`, `next build`, `1to1 console` on every route, `1to1 blackout .` CLEAN, final `1to1 verify` table for every route. Report honestly: what matches, what does not, what was not checked. Say it in origin-blind terms, and call out any placeholder logo or wordmark asset the user still has to replace.

## Behaviours

- Headed browser by default for `clone` / `extract` so the user sees it work. Everything else headless.
- The dev server runs on one port for the whole job (3777 by convention). Never start a second one; Next 16 refuses anyway.
- `?only=<section>` on the home route and `?only=1` on subpages render without the shell for clean per-section shots. Wire this into the page early.
- Framer breakpoints are desktop >= 1200, tablet 810 to 1199, phone < 810. A 768px screenshot is the phone layout. Capture at 1440 / 1024 / 810 / 390.
- Scroll reveals leave elements at opacity 0 until scrolled to. Every screenshot (reference and build) goes through the same reveal + scroll-and-stitch path in `lib/browser.ts`. Never use Playwright `fullPage` on a page with vh sections.
- Motion values come from source (`rip.md`, `framer-appear.json`, modules), not from eyeballing video. Frames are for verifying timing, not for guessing curves.
- When the API rate-limits or 529s builders, resume them by id (SendMessage) or relaunch on another model; the reference folder is durable, nothing is lost. Build the most important page yourself while waiting.
- Class-prefix every section's scoped CSS (`hero-`, `pj-`, `ab-` ...). Grep before picking a prefix; a collision once broke an unrelated section.
- No em dashes anywhere in generated code or docs.
- Origin blackout applies to you too: your own messages, the goal text, commit messages and the final report name the rebuild, never the source. Need the url for a rig? `"$(1to1 origin reference/site --url)"`, never typed out.
- Do not extract authenticated or paywalled sites without the user confirming they have the right to.

## Files

- `docs/METHOD.md` the end-to-end method with the reasoning behind each step
- `docs/FRAMER.md` Framer internals: breakpoints, the five motion mechanisms, how to read the modules, gotchas that cost pixels
- `docs/VERIFY.md` the verification loop and what PASS means
- `docs/AGENTS.md` orchestration: what to parallelize, prompts, failure handling
- `templates/` CONVENTIONS.md, PAGES.md, GOAL.md, prompts/ (motion-ripper, section-builder, motion-pass, page-builder)
- `src/lib/anon.ts` the origin blackout: token derivation, neutral names, scrubbing, the leak scanner
- `src/` the CLI (bun + playwright + sharp)
