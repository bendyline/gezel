/**
 * Baseline stylesheet shipped with the static Handboek export, written to
 * `<out>/assets/handboek.css` and linked first on every page.
 *
 * Tokens follow docs/design-guidelines.md: parchment canvas, warm ink, sage
 * as the identity color, terracotta as the action color, mostly-square
 * corners. The two brand faces are named first in each stack and fall back
 * to system equivalents — the export ships no fonts, and the guidelines rule
 * out loading them from a CDN, so a host site that self-hosts the WOFF2
 * files gets them automatically and everyone else gets a sane substitute.
 *
 * Every rule is single-class or element scoped so a host stylesheet linked
 * after this one can override it without fighting specificity.
 */
export const BASELINE_CSS = `:root {
  --hb-canvas: #eae5d6;
  --hb-panel: #f3eddf;
  --hb-reading: #f1e9e1;
  --hb-inset: #ddd3bd;
  --hb-ink: #1c1c1c;
  --hb-ink-warm: #2a2520;
  --hb-ink-muted: #5a4f42;
  --hb-ink-quiet: #8b7e6b;
  --hb-sage: #667f62;
  --hb-sage-forest: #3d4d3a;
  --hb-cream-ink: #f3ede0;
  --hb-accent: #b0724c;
  --hb-accent-hover: #996142;
  --hb-border: rgba(127, 127, 127, 0.25);
  --hb-radius-sm: 4px;
  --hb-radius-md: 6px;
  --hb-radius-lg: 10px;
  --hb-font-display: 'PT Serif', Georgia, 'Times New Roman', serif;
  --hb-font-ui: 'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --hb-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --hb-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 6px 18px rgba(0, 0, 0, 0.06);
  --hb-measure: 42rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --hb-canvas: #141517;
    --hb-panel: #1c1d20;
    --hb-reading: #1a1b1e;
    --hb-inset: #1f2124;
    --hb-ink: #f0f0f0;
    --hb-ink-warm: #ececec;
    --hb-ink-muted: #999999;
    --hb-ink-quiet: #808080;
    --hb-sage: #4d6149;
    --hb-accent: #c0875d;
    --hb-accent-hover: #d5a07a;
    --hb-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 18px rgba(0, 0, 0, 0.36);
  }
}

*, *::before, *::after { box-sizing: border-box; }

body.hb {
  margin: 0;
  background: var(--hb-canvas);
  color: var(--hb-ink);
  font-family: var(--hb-font-ui);
  font-size: 1rem;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.hb a { color: var(--hb-accent); text-decoration: none; }
.hb a:hover { color: var(--hb-accent-hover); text-decoration: underline; }
.hb a:focus-visible {
  outline: 2px solid var(--hb-accent);
  outline-offset: 2px;
  border-radius: var(--hb-radius-sm);
}

/* Masthead — sage is a place, never a control. */
.hb-masthead {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 1.5rem;
  padding: 0.85rem 1.5rem;
  background: var(--hb-sage);
  color: var(--hb-cream-ink);
}
.hb-brand {
  font-family: var(--hb-font-display);
  font-size: 1.15rem;
  font-weight: 700;
}

/* The product wordmark, back out to the surrounding site. Lowercase italic
   serif at PT Serif's natural 400 — the family ships only 400 and 700, so
   anything between synthesizes a weight. Set apart from the Handboek title
   by a hairline rule rather than by size. */
.hb-wordmark {
  font-family: var(--hb-font-display);
  font-style: italic;
  font-weight: 400;
  font-size: 1.15rem;
  text-transform: lowercase;
  padding-right: 0.6rem;
  margin-right: 0.1rem;
  border-right: 1px solid rgba(243, 237, 224, 0.35);
  opacity: 0.9;
}
.hb-wordmark:hover { opacity: 1; }
.hb-masthead a, .hb-masthead a:hover { color: var(--hb-cream-ink); }
.hb-areanav { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.9rem; }
.hb-areanav a { opacity: 0.85; }
.hb-areanav a:hover, .hb-areanav a[aria-current='true'] { opacity: 1; }
.hb-areanav a[aria-current='true'] { text-decoration: underline; text-underline-offset: 4px; }

/* Three-column reading layout: nav, article, on-this-page.
   The third column is reserved even on the ~300 generated catalog articles
   that carry too few headings to warrant a list, so the article body holds
   the same position as you click between pages instead of jumping. */
.hb-layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr) 13rem;
  gap: 2.5rem;
  align-items: start;
  max-width: 84rem;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}

.hb-sidebar, .hb-onthispage { position: sticky; top: 1.5rem; font-size: 0.9rem; }
.hb-sidebar section { margin-bottom: 1.5rem; }
.hb-sidebar h2, .hb-onthispage h2 {
  margin: 0 0 0.5rem;
  font-family: var(--hb-font-ui);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--hb-ink-quiet);
}
.hb-sidebar h2 a { color: inherit; }
.hb-sidebar h2.hb-current { color: var(--hb-ink-warm); }
.hb-sidebar ul, .hb-onthispage ul { list-style: none; margin: 0; padding: 0; }
.hb-sidebar li { margin: 0.15rem 0; }
.hb-sidebar a, .hb-onthispage a { color: var(--hb-ink-muted); }
.hb-sidebar a:hover, .hb-onthispage a:hover { color: var(--hb-accent); }
.hb-sidebar a.hb-current {
  color: var(--hb-accent);
  font-weight: 600;
  border-left: 2px solid var(--hb-accent);
  margin-left: -0.6rem;
  padding-left: 0.45rem;
}
.hb-onthispage li { margin: 0.2rem 0; }
.hb-onthispage .hb-h3 { padding-left: 0.75rem; font-size: 0.85rem; }
.hb-more { margin: 0.4rem 0 0; font-size: 0.85rem; }

.hb-breadcrumb { font-size: 0.85rem; color: var(--hb-ink-quiet); margin-bottom: 1rem; }
.hb-breadcrumb a { color: var(--hb-ink-muted); }
.hb-breadcrumb span { margin: 0 0.35rem; }

/* Article — the editorial register. Headings serif, everything else sans. */
.hb-article {
  max-width: var(--hb-measure);
  background: var(--hb-reading);
  border: 1px solid var(--hb-border);
  border-radius: var(--hb-radius-lg);
  box-shadow: var(--hb-shadow);
  padding: 2.5rem 2.75rem 3rem;
  color: var(--hb-ink-warm);
}
.hb-article h1, .hb-article h2, .hb-article h3,
.hb-article h4, .hb-article h5, .hb-article h6 {
  font-family: var(--hb-font-display);
  font-weight: 700;
  line-height: 1.25;
  color: var(--hb-ink-warm);
  margin: 2rem 0 0.75rem;
}
.hb-article a { font-family: var(--hb-font-ui); }
.hb-article h1 { font-size: 2rem; margin-top: 0; }
.hb-article h2 {
  font-size: 1.4rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--hb-border);
}
.hb-article h3 { font-size: 1.1rem; }
.hb-article p, .hb-article li { font-size: 1rem; }
.hb-article p { margin: 0 0 1rem; }
.hb-article ul, .hb-article ol { margin: 0 0 1rem; padding-left: 1.35rem; }
.hb-article li { margin: 0.3rem 0; }
.hb-article li > p { margin: 0; }
.hb-article img { max-width: 100%; height: auto; border-radius: var(--hb-radius-md); }
.hb-article hr { border: 0; border-top: 1px solid var(--hb-border); margin: 2rem 0; }
.hb-article blockquote {
  margin: 0 0 1rem;
  padding: 0.25rem 0 0.25rem 1rem;
  border-left: 3px solid var(--hb-accent);
  color: var(--hb-ink-muted);
}
.hb-article code {
  font-family: var(--hb-font-mono);
  font-size: 0.875em;
  background: var(--hb-inset);
  border-radius: var(--hb-radius-sm);
  padding: 0.1em 0.35em;
}
.hb-article pre {
  background: var(--hb-inset);
  border: 1px solid var(--hb-border);
  border-radius: var(--hb-radius-md);
  padding: 0.9rem 1.1rem;
  overflow-x: auto;
  margin: 0 0 1rem;
}
.hb-article pre code { background: none; padding: 0; font-size: 0.85rem; }

/* Wide content scrolls inside its own box; the page never scrolls sideways.
   The scroll lives on a wrapper, not on the table itself: display:block
   on a table makes it shrink-to-content and stop filling the column. */
.hb-table-scroll {
  overflow-x: auto;
  max-width: 100%;
  margin: 0 0 1.25rem;
}
/* A step down from body copy: the model scorecard puts eight columns of
   figures inside a 42rem reading measure, and at prose size the numbers get
   less room than the words around them. */
.hb-article table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.82rem;
  line-height: 1.45;
}
/* Prose cells wrap. Catalog tables pair a short name against a full sentence
   of description, so white-space:nowrap would push the description off the
   page and force a horizontal scroll to read every row.

   break-word, not anywhere: both keep an over-long token from spilling out
   of the table, but "anywhere" also lets the browser count a single
   character as a column's minimum width, so a squeezed table shreds its
   headings mid-word ("Rea" / "ds" / "at"). With break-word a column never
   narrows past its longest word, and the excess goes to the scroller. */
.hb-article th, .hb-article td {
  border: 1px solid var(--hb-border);
  padding: 0.4rem 0.45rem;
  text-align: left;
  vertical-align: top;
  overflow-wrap: break-word;
  min-width: 3rem;
}
.hb-article th { background: var(--hb-inset); font-weight: 600; }
/* Keep the leading label column from collapsing to one word per line while
   the description column takes the slack. */
.hb-article tbody td:first-child { min-width: 6rem; }

.hb-watch { max-width: var(--hb-measure); margin: 1.25rem 0 0; font-size: 0.9rem; }

/* Home */
.hb-home-main { max-width: 62rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
.hb-hero { max-width: var(--hb-measure); margin-bottom: 3rem; }
.hb-hero h1 {
  font-family: var(--hb-font-display);
  font-size: 2.6rem;
  line-height: 1.15;
  margin: 0 0 1rem;
  color: var(--hb-sage-forest);
}
@media (prefers-color-scheme: dark) {
  .hb-hero h1 { color: var(--hb-ink-warm); }
}
.hb-lede { font-size: 1.15rem; line-height: 1.6; color: var(--hb-ink-muted); margin: 0; }

.hb-home h2 {
  font-family: var(--hb-font-display);
  font-size: 1.3rem;
  margin: 0 0 0.75rem;
  color: var(--hb-ink-warm);
}
.hb-home h2 a { color: inherit; }
.hb-home h2 a:hover { color: var(--hb-accent); }

.hb-cards { list-style: none; margin: 0 0 3rem; padding: 0; display: grid; gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
.hb-cards a {
  display: block;
  height: 100%;
  padding: 1rem 1.1rem;
  background: var(--hb-panel);
  border: 1px solid var(--hb-border);
  border-radius: var(--hb-radius-lg);
  box-shadow: var(--hb-shadow);
  color: var(--hb-ink-warm);
  text-decoration: none;
}
.hb-cards a:hover { border-color: var(--hb-accent); text-decoration: none; }
.hb-card-title { display: block; font-weight: 600; margin-bottom: 0.25rem; }
.hb-card-summary { display: block; font-size: 0.9rem; color: var(--hb-ink-muted); }

.hb-areas { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
.hb-area-blurb { color: var(--hb-ink-muted); margin: 0 0 0.6rem; font-size: 0.95rem; }
.hb-arealist { list-style: none; margin: 0 0 0.5rem; padding: 0; font-size: 0.95rem; }
.hb-arealist li { margin: 0.2rem 0; }

.hb-footer {
  border-top: 1px solid var(--hb-border);
  padding: 1.5rem;
  text-align: center;
  font-size: 0.85rem;
  color: var(--hb-ink-quiet);
}
.hb-footer p { margin: 0; }

@media (max-width: 68rem) {
  .hb-layout { grid-template-columns: 13rem minmax(0, 1fr); }
  .hb-onthispage { display: none; }
}
@media (max-width: 48rem) {
  .hb-layout { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; padding: 1.25rem 1rem 3rem; }
  .hb-sidebar { position: static; }
  .hb-article { padding: 1.5rem 1.25rem 2rem; }
  .hb-hero h1 { font-size: 2rem; }
}
`;
