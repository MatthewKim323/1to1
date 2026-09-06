/** Split a stylesheet into (media, selector, body) triples, descending into @media blocks. */
export type Rule = { media: string; selector: string; body: string };

export function* cssBlocks(css: string, media = ''): Generator<Rule> {
  let i = 0;
  const n = css.length;
  while (i < n) {
    const j = css.indexOf('{', i);
    if (j < 0) break;
    const sel = css.slice(i, j).trim();
    if (sel.startsWith('@media')) {
      let depth = 1;
      let k = j + 1;
      while (depth && k < n) {
        if (css[k] === '{') depth++;
        else if (css[k] === '}') depth--;
        k++;
      }
      yield* cssBlocks(css.slice(j + 1, k - 1), sel);
      i = k;
    } else if (sel.startsWith('@')) {
      // @font-face, @keyframes, @supports: keep as one rule with the raw body
      let depth = 1;
      let k = j + 1;
      while (depth && k < n) {
        if (css[k] === '{') depth++;
        else if (css[k] === '}') depth--;
        k++;
      }
      yield { media, selector: sel, body: css.slice(j + 1, k - 1).trim() };
      i = k;
    } else {
      const k = css.indexOf('}', j);
      if (k < 0) break;
      yield { media, selector: sel, body: css.slice(j + 1, k).trim() };
      i = k + 1;
    }
  }
}

/** Drop the Framer noise nobody needs when rebuilding. */
export function cleanBody(body: string) {
  let b = body.replace(/--framer-font-family-(bold|italic|bold-italic):[^;]+;/g, '');
  b = b.replace(/--framer-font-(style|weight)-(bold|italic|bold-italic):[^;]+;/g, '');
  b = b.replace(/--framer-(text-stroke-[a-z]+|font-variation-axes|font-open-type-features|text-decoration|paragraph-spacing|text-transform|font-style|link-text-color|link-text-decoration):[^;]+;/g, '');
  b = b.replace('will-change:var(--framer-will-change-override,transform);', '').replace('will-change:var(--framer-will-change-effect-override,transform);', '');
  b = b.replace('overflow:var(--overflow-clip-fallback,clip)', 'overflow:clip');
  return b;
}

export function stylesFromHtml(html: string) {
  return Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)).map((m) => m[1]).join('\n');
}
