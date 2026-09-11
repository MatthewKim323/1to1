You are building ONE section of a pixel-perfect rebuild in {{PROJECT}} ({{STACK}}), shipped as {{BRAND}}'s own site. First read {{PROJECT}}/reference/CONVENTIONS.md fully and follow it exactly.

ORIGIN BLACKOUT (rule zero): nothing you write may say where this came from. No origin name, host, brand, logo filename, link, or "cloned from / based on / like <site>" in any component, file name, class name, comment, alt text, metadata, doc or reply. The reference is already scrubbed: where it reads `{{BRAND}}`, that is the copy. Never look up the source url or open the live page. `1to1 blackout {{PROJECT}}` must print CLEAN before you report done.

Your section: **{{SECTION_NAME}}** (`data-framer-name="{{SECTION_NAME}}"`). Write it to `components/sections/{{FILE}}.tsx` (a stub exists; overwrite it; export `function {{COMPONENT}}()`). Your scoped CSS class prefix is `{{PREFIX}}-`. It is already registered in app/page.tsx; do NOT edit page.tsx, layout.tsx, globals.css or other sections. You may add reusable primitives under components/ui/ if truly needed (re-read a shared file before editing it; another builder may have touched it; extend backward-compatibly).

Inputs:
- Spec (tree + CSS per breakpoint): {{REF}}/spec/sections/{{SPEC_FILE}}
- Reference crops (2x): {{REF}}/capture/desktop/sections/{{CROP}}, and the same name under capture/tablet/, capture/tablet-810/, capture/mobile/. On the live page this section spans y {{Y0}} to {{Y1}} at 1440 (height {{H}}); at 1024 {{H1024}}, at 810 {{H810}}, at 390 {{H390}}.
- Layout truth: {{REF}}/capture/<vp>/layout.json. `1to1 refboxes {{REF}} desktop {{Y0}} {{Y1}}` prints the reference boxes; `1to1 boxes "http://localhost:{{PORT}}/?only={{ONLY}}" 1440 0 {{H}}` prints yours (same columns). Use them to verify every size and position, not just screenshots.
- Motion: {{REF}}/motion/component-specs.md §{{SPEC_SECTION}} and motion/transitions.json if present. If absent or incomplete for your section, use the observed pattern ({{OBSERVED_MOTION}}) with `revealSpring` and mark every guessed value `// TODO(spec)`; a motion pass replaces them later.

Section content (from the reference): {{CONTENT_NOTES}}

Process: build, then `1to1 shot "http://localhost:{{PORT}}/?only={{ONLY}}" {{REF}}/build/{{FILE}}-1440.png --w 1440`, Read it next to the desktop crop, fix spacing / type / colors / positions, repeat until they match and the section height equals {{H}}. Then `--w 1024`, `--w 810`, `--w 390` against the tablet / phone crops and heights. Framer `data-border` borders are overlays (inset box-shadow, never a real border). `bunx tsc --noEmit -p {{PROJECT}}` must pass and `1to1 blackout {{PROJECT}}` must print CLEAN. Check the dev log for runtime errors from your component. No em dashes anywhere.

Reply with: what you built, the section height at each width (yours vs reference), the remaining known mismatches (be honest), and any TODO(spec) placeholders you left.
