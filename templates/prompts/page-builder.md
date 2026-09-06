Build the `{{ROUTE}}` page of the 1:1 rebuild of {{URL}} in {{PROJECT}}. Read {{PROJECT}}/reference/PAGES.md first (it links CONVENTIONS.md; read both fully).

Scope: overwrite `components/pages/{{FILE}}.tsx` (`export function {{COMPONENT}}()`). Your scoped CSS prefix is `{{PREFIX}}-`. You may add reusable pieces under components/ui/ ({{SHARED_NOTES}}; if another builder may create the same piece concurrently, check whether it exists first and reuse it; otherwise create it generic). Do not edit nav / footer / shell / layout / globals or other pages.

Reference: {{REF}}/ (spec/page.txt, capture/<vp>/{full.png, layout.json, sections/} at 1440 / 1024 / 810 / 390, motion/framer-appear.json, motion/rip.md, modules/, assets/). Page heights to match: {{HEIGHTS}}. Page content between nav and footer, top to bottom: {{CONTENT_NOTES}}. Copy exact text from the tree.

Data: {{DATA_NOTES}} (CMS listings: `1to1 cms <live url> out.json` collects every item with categories across tabs and Load More; page size per breakpoint is in the page module near the collection query. Detail pages: parse SSR html into rich HTML, not plain text.)

Motion: on-mount appears from framer-appear.json (appear-by-name.json joins ids to names), scroll "Enter" effects from the `__framer__transformTargets` windows in motion/rip.md (ScrollReveal + FX springs; never whileInView), variant-on-scroll, text effects, hovers with the exact component transitions (motion/constants.json), tab / load-more behaviour as the live page does it.

Verify at 1440 / 1024 / 810 / 390: `1to1 shot "http://localhost:{{PORT}}{{ROUTE}}?only=1" {{REF}}/build/<w>.png --w <w>` against capture/<vp>/full.png; `1to1 heights http://localhost:{{PORT}}{{ROUTE}} {{LIVE_URL}}` until page and section heights match; `1to1 boxes` vs `1to1 refboxes {{REF}} <vp> <y0> <y1>` for the last pixels; `1to1 verify http://localhost:{{PORT}}{{ROUTE}} {{REF}}`. Framer `data-border` borders are overlays (inset box-shadow, never a real border). `bunx tsc --noEmit -p {{PROJECT}}` must pass. No em dashes anywhere.

Reply with: what you built, the heights table (yours vs reference per width), the exact motion / tab / pagination values found, and any mismatch left (be honest).
