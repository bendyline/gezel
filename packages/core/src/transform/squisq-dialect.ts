/**
 * The Squisq authoring dialect, described once for every prompt that asks
 * a model to write document content. Documents, artifacts, task
 * descriptions, and chat replies all render through Squisq's extended
 * markdown — mermaid fences and "Squiggly Square" `{[template …]}`
 * annotations (canonical spec: squisq repo, docs/SquigglySquare.md) — but
 * no model can know that unless the prompt says so.
 *
 * Two sizes, one source, so the wording can't drift between surfaces:
 * `SQUISQ_DIALECT_NOTE` is the example-led block for one-shot writing
 * prompts (the transform dialog's rewrite/insert path); `SQUISQ_DIALECT_BRIEF`
 * is the two-sentence version folded into the chat system prompt's
 * standing markdown guidance, where every extra token costs attention on
 * small local models.
 *
 * Syntax below is copied from the SquigglySquare spec, not from memory —
 * verify against the sibling squisq checkout before extending. Longer
 * term this text should be exported by squisq itself so a feature
 * release updates the prompt on pin bump (same "runtime is the source
 * of truth" reasoning as ADR 0001).
 */

export const SQUISQ_DIALECT_NOTE = `### Squisq extended markdown

This content renders in Squisq, an extended markdown. Where it genuinely helps, you may use:

- Mermaid diagrams in a fenced block:
  \`\`\`mermaid
  graph LR; Draft --> Review --> Publish
  \`\`\`
- Squiggly Square template annotations, trailing on a heading, to style that section: \`## Q3 numbers {[dataTable]}\` (a markdown table in the body supplies the data), \`## Where we work {[map center="47.6,-122.3" zoom=9]}\`, \`## In their words {[quote]}\`. Other built-in templates: statHighlight, factCard, twoColumn, imageWithCaption, photoGrid, comparisonBar, definitionCard, list, diagram.

Plain prose is the default — reach for these only when a diagram or structured block genuinely clarifies the content.`;

export const SQUISQ_DIALECT_BRIEF =
  'Rendering is Squisq extended markdown: a ```mermaid fence renders as a diagram, and a heading may carry a Squiggly Square template annotation (e.g. `## Q3 numbers {[dataTable]}`) to style its section. Use these in documents when a diagram or structured block genuinely helps — plain prose stays the default.';

/**
 * Writing a Squisq slideshow: scenes, photos, motion. Injected on a craftbook
 * step that declares `authoring: 'squisq-slideshow'` (a photo album, a
 * narrated slideshow), so no book carries its own copy of the syntax. Checked
 * against SquigglySquare.md and squisq's template registry (`content`,
 * `imageWithCaption`, `photoGrid`; `TRANSITION_TYPES`); re-check on a pin bump.
 */
export const SQUISQ_SLIDESHOW_NOTE = `### Writing a Squisq slideshow

The file is a Squisq slideshow: Markdown the person can play, edit and export to video.

- Frontmatter first. The first \`#\` heading and the sentence under it also become the cover:
  \`\`\`
  ---
  title: Beach afternoon
  squisq-theme: gezellig
  ---
  # Beach afternoon

  A long, lazy afternoon by the water.
  \`\`\`
- Every heading starts a new slide. A slide's layout goes at the END of its heading line, inside \`{[ ]}\`.
- One photo: \`## The sandcastle {[imageWithCaption caption="Where the day began"]}\`, then the photo alone on the next line: \`![The sandcastle](Camera/IMG_0001.jpg)\`.
- Two to four photos of one moment: \`## Late swim {[photoGrid caption="The water was cold"]}\`, then each photo on its own line.
- A slide of words: \`## What we learned {[content]}\` with two to four short bullets under it.
- Optional in any slide's annotation: \`ambientMotion=zoomIn\` (or zoomOut, panLeft, panRight) slowly moves a photo; \`transition=dissolve\` (or fade, push, wipe, zoom); \`duration=6\` seconds.
- Quote any value with a space in it. No HTML, and no tables on photo slides.`;

/**
 * Books keep rules of their own (a deck splits slides on `#`, a report uses
 * `##` sections), and an example here must never override them.
 */
const STEP_PROCEDURE_DECIDES =
  "The step's procedure decides heading levels, slide breaks and layout; where it differs from these notes, follow the procedure.";

/** The note a craftbook step's `authoring` declaration asks for. */
export function squisqAuthoringNote(kind: 'squisq' | 'squisq-slideshow'): string {
  const note = kind === 'squisq-slideshow' ? SQUISQ_SLIDESHOW_NOTE : SQUISQ_DIALECT_NOTE;
  return `${note}\n\n${STEP_PROCEDURE_DECIDES}`;
}
