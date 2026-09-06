You are reverse-engineering a Framer-exported site so it can be rebuilt 1:1 in {{STACK}}. Everything is on disk at {{REF_ABS}}/. Do NOT modify anything outside {{REF_ABS}}/motion/ and {{REF_ABS}}/analysis/.

Inputs:
- modules/<biggest>.mjs: the page module. Framer-generated, one giant line. Contains every section as JSX-ish code with `data-framer-name` labels, transition constants like `const X={bounce:.2,delay:0,duration:.4,type:\`spring\`}` (strings are backtick-quoted), variant maps (`variantClassNames`, `humanReadableVariantMap`), hover / press handlers via `useActiveVariantCallback`, `addPropertyOverrides(...)`, Ticker props (`tickerEffect*`), scroll effect props (`__framer__transformTargets`, `__framer__spring`, `__framer__targets`, `__framer__threshold`), text effects (`tokenization`), drag props, and `initial` / `animate` objects.
- motion/rip.md: windows of context around every one of those patterns, per module, plus each module's transition constants (also in motion/constants.json). Start here; go to the modules for anything it cut off.
- motion/modules.md: per module, the component scope classes and display names. The other modules are shared components (Button, Nav, Menu), CMS collections, code components (count-ups, progress lines, tickers), text presets, and the runtime (framer.*.mjs). Identify what each one is.
- framer.*.mjs (runtime): consult only for how props are interpreted (Ticker speed formula and px/s, hover behaviour, fade edges; scroll transform offset and spring chase; text effect stagger; variant-on-scroll range math).
- dom/full.html + dom/tree.txt: rendered DOM with inline styles, `data-framer-appear-id` and `data-framer-name`.
- motion/framer-appear.json: appear animations keyed by appear id then breakpoint hash: {initial, animate:{transition}}. motion/appear-by-name.json joins ids to element names. A `default: null` entry means no mount animation on desktop; check the other keys.
- The five mechanisms and how the runtime interprets each are described in the 1to1 skill docs/FRAMER.md. Read it first.

Deliverables (write these files):

1. analysis/modules.md: one line per module: what it is, what component(s) it exports (display name + scope class), which section uses it.

2. motion/component-specs.md: THE spec for the rebuild. Start with §0 global facts: preloader yes / no, breakpoints, smooth scroll, the five mechanisms as used on this page, a glossary of the transition constants with names (SPRING_A = ..., etc). Then for each section in page order (Nav, Hero, ... Footer, plus any overlay / preloader / fixed element), list:
   - the `data-framer-name` tree for the section (meaningful nodes only);
   - appear animations: for each element with an appear id in the section: id, element name / text, exact initial / animate / transition per breakpoint, converted to framer-motion props verbatim, e.g. `initial={{opacity:0.001,y:64}} animate={{opacity:1,y:0}} transition={{type:'spring',bounce:0.2,duration:0.4,delay:0.4}}`; state on-mount vs in-view explicitly;
   - scroll "Enter" effects: element, `from` target, spring (damping / stiffness / mass), perspective flag; state clearly that these are scroll-progress-linked (offset ['start end','end end']), reversible, not whileInView, and give the useScroll / useTransform / useSpring rebuild;
   - variant switches on scroll: refs, threshold, which variant per range, animateOnce;
   - hover / press / variant transitions: buttons, cards, nav links, accordion, pricing, testimonials: exact transition constant and which properties change to what (backgroundColor, gradient stops, boxShadow, scale, x / y, rotate, opacity, borderRadius, color);
   - ticker: all tickerEffect* props and, from the runtime, px/s, gap, fade edges, direction, hover behaviour, draggable;
   - scroll-linked code components (progress lines, parallax, sticky): all props as used and the algorithm;
   - loops (`repeat: Infinity`, pulses, rotating icons) and canvas / WebGL: find what draws on each `<canvas>`, transcribe the drawing code or shader + every uniform value;
   - text effects: tokenization, effect values, spring, stagger, trigger, repeat.

3. motion/transitions.json: machine-readable: { constants: {...}, sections: [{ name, elements: [{ framerName, appearId, mechanism: "ssr-appear" | "scroll-transform" | "scroll-target" | "variant-on-scroll" | "text-effect" | "gesture" | "loop", initial, animate, transition, spring, from, trigger, hover, tap }] }], ticker: {...}, codeComponents: [...], loops: [...] }.

Rules:
- Quote exact numbers from the source. Never invent or round. `ease:[.44,0,.56,1]` stays `[.44,0,.56,1]`.
- If something is ambiguous, say what you found and what is uncertain rather than guessing.
- Work with grep / python regex windows over the files (print 600 to 800 chars around matches). Do not try to read a whole module.
- Be exhaustive. A missing hover state is a failure.
- No em dashes anywhere.
- When done, reply with a ~20 line summary: preloader yes / no, number of appear animations, the constants glossary, ticker speed, scroll-effect springs used, anything surprising.
