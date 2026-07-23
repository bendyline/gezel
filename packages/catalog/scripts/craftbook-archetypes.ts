import type { ArchetypeSpec } from '../src/archetype.js';

/**
 * Seed archetype specs for the gallery. Hand-authored exemplars that
 * realize the kinds of tasks the gallery exists for — and that demonstrate
 * the two things a specific book encodes over the generic `build-loop`:
 * the right specialist role per phase, and a domain-correct ordering
 * (e.g. branding sites lock a visual language BEFORE any HTML).
 *
 * `generate-craftbooks.ts` turns each of these into a bundled craftbook
 * under `data/craftbook-templates/`. Scaling to the full 300-400 means
 * adding more specs here (drafted by hand, or by an LLM that emits the
 * small spec — never raw craftbook JSON); the deterministic generator
 * guarantees every one is schema-valid and consistently gated.
 */
export const SEED_ARCHETYPES: ArchetypeSpec[] = [
  {
    id: 'html-arcade-game',
    name: 'HTML Arcade Game',
    description:
      'Build a playable single-file HTML/canvas arcade game (shooter, runner, dodger, etc.). Splits design into game-mechanics and visual look, builds, then evaluates against a playability bar and loops until it is actually fun and bug-free.',
    tags: ['game', 'html', 'canvas', 'interactive'],
    triggers: ['arcade game', 'space shooter', 'html game', 'build a game'],
    phases: [
      {
        id: 'game-design',
        name: 'Game design',
        role: 'game-designer',
        summary: 'mechanics, controls, win/lose, difficulty',
        prompt:
          'Design the GAME, not the code. Decide: core mechanic (what the player does), controls (keys/mouse/touch), win and lose conditions, and the difficulty curve. Then write an **acceptance-criteria checklist** (4-8 concrete, checkable items, e.g. "arrow keys move the ship", "colliding with an enemy ends the game", "score increments on hit", "game is playable for >30s without a JS error"). `write_task_note` the mechanics + the checklist. No code, no visuals yet.',
      },
      {
        id: 'visual-design',
        name: 'Visual design',
        role: 'visual-designer',
        summary: 'palette, shapes/sprites, layout, juice',
        prompt:
          'Decide how it LOOKS. Pick a palette, the shapes or sprites for player/enemies/projectiles, the HUD layout (score, lives), and a touch of juice (a flash on hit, a simple particle). Keep it self-contained — canvas drawing or CSS, no external asset downloads. `write_task_note` the visual spec so the build phase has a concrete target. Still no game code.',
      },
      {
        id: 'build',
        name: 'Build',
        role: 'developer',
        summary: 'implement the game in one index.html',
        prompt:
          'Implement the game in a single `index.html` (inline CSS + JS) that satisfies the acceptance criteria and matches the visual spec. Real game loop, real input handling, real state. On a loop-back, fix only the gaps the reviewer named — do not regress criteria that already passed. `write_task_note` the path and which criteria now pass.',
      },
    ],
    evaluate: {
      prompt:
        'Actually exercise the game. If a browser/QA capability is available, load `index.html`, play it, and watch the console for errors; otherwise read the source and trace the loop. Check each acceptance criterion (mechanic works, controls respond, win/lose fires, no console errors) and write a PASS/FAIL per criterion.',
    },
  },
  {
    id: 'branding-website',
    name: 'Branding Website',
    description:
      'Build a small brand/marketing website where the visual identity leads. Locks a visual language and mockups FIRST, then writes the copy, then builds the HTML to the locked design — the ordering that makes brand sites feel designed rather than templated.',
    tags: ['website', 'branding', 'marketing', 'design', 'html'],
    triggers: ['branding website', 'landing page', 'marketing site', 'brand site'],
    phases: [
      {
        id: 'brand-design',
        name: 'Brand & visual design',
        role: 'visual-designer',
        summary: 'visual language + mock, BEFORE any HTML',
        prompt:
          'Lock the visual language before a line of HTML exists. Decide: palette (with hex), type pairing, spacing/scale, and the hero treatment. Produce a concrete mock — an ASCII/markdown wireframe of each section (hero, value props, CTA, footer) is fine, or generate a hero image if image tools are available. Write an **acceptance-criteria checklist** that includes the brand rules ("headings use <font>", "palette is exactly <hex list>", "hero matches the mock"). `write_task_note` the visual language + mock + checklist. No HTML yet.',
      },
      {
        id: 'copy',
        name: 'Copywriting',
        role: 'copywriter',
        summary: 'headlines + section copy to the brand voice',
        prompt:
          'Write the words. Headline, subhead, 3 value-prop blurbs, CTA label, footer. Match the brand voice implied by the visual language. Keep it tight — marketing copy, not paragraphs. `write_task_note` the copy block, keyed by section, so the build phase drops it straight in.',
      },
      {
        id: 'build',
        name: 'Build',
        role: 'developer',
        summary: 'implement index.html to the locked design + copy',
        prompt:
          'Implement `index.html` (inline CSS) to the locked visual language and the approved copy — do not redesign in code. Honor the exact palette, type, and section order from the mock. Responsive, no external assets unless already generated. On a loop-back, fix only the named gaps. `write_task_note` the path and which criteria now pass.',
      },
    ],
    evaluate: {
      prompt:
        'Check the built site against the brand acceptance criteria specifically: does the palette match the locked hex list, the type match, the section order match the mock, the copy match what was approved? Render it if you can. A site that works but ignores the locked visual language FAILS — loop back to build.',
    },
  },
  {
    id: 'image-set-index',
    name: 'Index & Describe an Image Set',
    description:
      'Given a folder of images, produce a structured index that describes each one (caption, tags, notable content) in a consistent schema, then validates coverage and consistency. For cataloguing, search, or alt-text generation over an image collection.',
    tags: ['images', 'index', 'catalog', 'data', 'vision'],
    triggers: ['index images', 'describe images', 'caption a folder', 'image catalog'],
    phases: [
      {
        id: 'scope',
        name: 'Scope the index',
        role: 'planner',
        summary: 'fields per image + output schema + criteria',
        prompt:
          'Decide the index schema before describing anything: which fields per image (filename, caption, tags, dominant colors, any flags), the output format (JSON/CSV/markdown table), and where it lands. Write an **acceptance-criteria checklist** ("every image in the folder has a row", "captions are 1-2 sentences", "tags are from a consistent vocabulary"). `write_task_note` the schema + checklist.',
      },
      {
        id: 'describe',
        name: 'Describe each image',
        role: 'developer',
        summary: 'read each image, write structured descriptions',
        prompt:
          'List the image folder, then for each image use the image-reading capability (e.g. `read_image_as_base64` + a vision-capable turn, or the available describe tool) to produce the fields from the schema. Keep the vocabulary consistent across images. Stage results as you go so progress is observable. Do not skip images.',
      },
      {
        id: 'assemble',
        name: 'Assemble the index',
        role: 'developer',
        summary: 'write the index file in the chosen format',
        prompt:
          'Write the full index to a single file in the chosen format. Ensure it parses (valid JSON/CSV). On a loop-back, fix only the named gaps (missing rows, inconsistent tags). `write_task_note` the index path and a coverage count (rows vs images).',
      },
    ],
    evaluate: {
      prompt:
        'Check coverage and consistency: does every image have a row, do captions/tags follow the schema and a consistent vocabulary, does the file parse? Spot-check a few descriptions against the actual images if you can. Write PASS/FAIL per criterion.',
    },
    finishPrompt:
      'Every criterion passed. Write a DONE summary: index path, format, image count, and a one-line note that coverage is complete and the schema is consistent.',
  },
  {
    id: 'content-deck',
    name: 'Slide Deck from Content',
    description:
      'Turn a body of source content into a presentation deck. Outlines the narrative first, designs a consistent slide look, then builds the deck (HTML slides), evaluating for narrative flow and visual consistency.',
    tags: ['deck', 'slides', 'presentation', 'content', 'html'],
    triggers: ['slide deck', 'powerpoint', 'presentation', 'build a deck'],
    phases: [
      {
        id: 'outline',
        name: 'Outline the deck',
        role: 'planner',
        summary: 'narrative arc + per-slide bullets from the source',
        prompt:
          'Read the source content and outline the deck: a title slide, a clear narrative arc, and one idea per slide with 2-4 bullets each. Aim for a tight deck, not every detail. Write an **acceptance-criteria checklist** ("opens with a title slide", "one idea per slide", "ends with a takeaways/CTA slide", "every claim traces to the source"). `write_task_note` the outline + checklist.',
      },
      {
        id: 'slide-design',
        name: 'Slide design',
        role: 'designer',
        summary: 'a consistent slide template + palette',
        prompt:
          'Design one reusable slide template: title position, body layout, palette, type scale, and how lists render. Consistency across slides matters more than flourish. `write_task_note` the template spec so the build phase applies it uniformly. No slide content yet.',
      },
      {
        id: 'build',
        name: 'Build the deck',
        role: 'developer',
        summary: 'generate the slides to the template',
        prompt:
          'Build the deck as a single navigable `index.html` (one section per slide, arrow-key/scroll navigation) applying the template uniformly and filling in the outlined content. On a loop-back, fix only the named gaps. `write_task_note` the deck path and slide count.',
      },
    ],
    evaluate: {
      prompt:
        'Check narrative flow (does it open with a title and end with takeaways, one idea per slide), visual consistency (every slide uses the template), and fidelity (claims trace to the source). Render/scan it if you can. Write PASS/FAIL per criterion.',
    },
  },
  {
    id: 'corpus-email-digest',
    name: 'Daily Email Digest from a Corpus',
    description:
      'Produce an email-ready digest that summarizes a corpus of content (docs, feeds, notes) for a recurring send. Scopes what matters and the format first, drafts the digest in a consistent voice, then builds the email-ready output and evaluates for accuracy and scannability.',
    tags: ['summary', 'email', 'digest', 'content', 'reporting'],
    triggers: ['daily summary', 'email digest', 'summarize this corpus', 'briefing'],
    phases: [
      {
        id: 'scope',
        name: 'Scope the digest',
        role: 'planner',
        summary: 'what to include, sections, format, length',
        prompt:
          'Decide what a good digest of this corpus looks like: which sources/sections to include, the section structure (e.g. headline, top items, one-line each), target length, and tone. Write an **acceptance-criteria checklist** ("≤ N items per section", "every item links/cites its source", "scannable in under a minute", "no item older than the window"). `write_task_note` the structure + checklist.',
      },
      {
        id: 'draft',
        name: 'Draft the digest',
        role: 'copywriter',
        summary: 'write the digest from the corpus, with citations',
        prompt:
          'Read the corpus and write the digest to the scoped structure. One tight line per item, each citing its source. Lead with what matters. Consistent voice. Do not invent items not in the corpus. `write_task_note` the draft.',
      },
      {
        id: 'build',
        name: 'Build the email output',
        role: 'developer',
        summary: 'render to an email-ready format',
        prompt:
          'Render the approved draft to the email-ready deliverable (HTML email or the requested format), with working links and a subject line. Keep it inline-styled and client-safe (no external CSS). On a loop-back, fix only the named gaps. `write_task_note` the output path.',
      },
    ],
    evaluate: {
      prompt:
        'Check accuracy (every item traces to the corpus, nothing invented), citations (each item links its source), scannability (skimmable in under a minute, within length), and freshness (within the window). Write PASS/FAIL per criterion.',
    },
  },
];
