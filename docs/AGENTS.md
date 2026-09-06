# Orchestration

What to run in parallel, what each agent gets, and what to do when the API falls over. Prompts are in `templates/prompts/`; fill the placeholders and pass them verbatim.

## Timeline that worked (home page, 11 sections)

| t | main agent | parallel agents |
|---|---|---|
| 0 | `1to1 clone`, read captures, scaffold app, tokens, fonts, Lenis, primitives, nav + hero | motion-ripper (spec from modules); capture rig runs headless |
| +15m | write CONVENTIONS.md, stub every section file, register them in the page, `?only=` switch | 10 section builders, one per section |
| +30m | integrate as they report: `1to1 heights`, bisect leaks, fix the shared header, shader port | remaining builders |
| +45m | phone + tablet sweep with boxes / refboxes | 3 motion-pass agents (3 to 4 sections each) |
| +60m | load frames vs reference, ticker speed, menu frames, production build, console sweep | |

Subpages: build the shared shell (nav + footer + route fade + `?only=1`) and stub every route first, then one page builder per route in parallel (projects, about, articles + detail template + data, contact + 404). Integrate each with the box-diff loop; the builders get close, the main agent finishes the last pixels.

## What every builder needs in its prompt

- the project path, the dev URL and port, and "do not start another dev server"
- `CONVENTIONS.md` (read fully first) and, for routes, `PAGES.md`
- exactly which file(s) it owns and which it must not touch
- its spec slice, its crops at three widths, `layout.json`, the section's y-range on the live page
- the screenshot command with `?only=` and the compare-with-Read loop, and the widths to check
- the motion policy: either "use `revealSpring` and mark `// TODO(spec)`" (before the spec exists) or "wire the exact values from component-specs.md §N"
- what to reply with: what was built, honest remaining mismatches, TODOs left

Give builders the observed pattern for their motion when the spec is not ready (e.g. "cards stagger in with y 89/119/149, opacity .001 to 1") so their layout leaves the right hooks; the motion pass replaces the values.

## Model and failure handling

- Rate limit (429 with a reset time): nothing to do but wait; the reference folder and the stubs are durable. Note the reset time in the status message.
- Overload (529) on every builder: resume each agent by id (SendMessage keeps its context), back off 2 to 5 minutes between rounds, then relaunch on another model (opus, then sonnet). Sonnet builders finished about/articles/contact to within tens of px; the main agent closed the rest with boxes / refboxes.
- While builders are down, build the most valuable page yourself. Do not idle.
- A builder that "finished" with heights off by more than a few px gets a follow-up message with the exact section table (ref vs build per width) and the boxes method, not a rebuild.

## Concurrency hazards

- Two builders extending the same primitive (SectionHeader, InfoCard) concurrently: tell them to extend backward-compatibly and to re-read the file before editing. Verify the shared primitive after both report.
- Class-prefix collisions: assign the prefix in the prompt (`pj-`, `ab-`, `ar-`, `ad-`, `ct-`, `nf-`) and forbid others.
- Capture rigs still writing while builders read: builders should check for `capture/<vp>/layout.json` and fall back to the extractor screenshots until it exists.

## Prompts

- `templates/prompts/motion-ripper.md`: modules to component-specs.md + transitions.json
- `templates/prompts/section-builder.md`: one home section, layout first
- `templates/prompts/motion-pass.md`: attach exact motion to built sections
- `templates/prompts/page-builder.md`: one route, content between nav and footer
