# Goal text

Set this with `/goal` at the start of a 1:1 job (Claude Code's session-scoped stop hook; it keeps the session working until the condition holds and clears itself when it does). Fill the placeholders. Keep the condition objective: measured, not "looks right". Never write the source url into the goal text; it is session-visible and the rebuild never names its origin.

```
/goal Rebuild the captured reference 1:1 in {{PROJECT}} as {{BRAND}}'s own site. Done means, for every route ({{ROUTES}}): `1to1 verify http://localhost:{{PORT}}/<route> <that route's reference dir under {{PROJECT}}/reference/> --diff` reports PASS at 1440, 1024, 810 and 390 (page height and every section height equal to the capture, zero console errors, origin blackout CLEAN: nothing in the project names the source); on-mount, scroll, hover and loop motion wired from the ripped source values (component-specs.md), with load and section-scroll timing checked frame by frame against capture/frames; `bunx tsc --noEmit` clean and `next build` green. Do not stop at "close": find every remaining pixel with 1to1 boxes vs refboxes. Boil the ocean.
```

Shorter variant when the user says it in their own words: keep their phrasing, append the measurable part:

```
/goal <user's words>. Measurable: 1to1 verify PASS on every route at 1440/1024/810/390 (blackout CLEAN included), tsc clean, next build green, console clean.
```
