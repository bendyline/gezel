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
    role: 'project-starter',
    release: { version: '1.2.1', releasedAt: '2026-08-14T00:00:00Z' },
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
          'Design the GAME, not the code. Decide: core mechanic (what the player does), controls (keys/mouse/touch), win and lose conditions, scoring, restart behavior, and the difficulty curve. Then write an **acceptance-criteria checklist** (4-8 concrete, checkable items, e.g. "arrow keys move the ship", "colliding with an enemy ends the game", "score increments on hit", "restart resets the score", "game is playable for >30s without a JS error"). Save the complete mechanics + checklist to artifact `design/game-design.md` with `write_artifact`, and summarize the path in task notes. No code, no visuals yet.',
        produces: {
          path: 'design/game-design.md',
          kind: 'markdown-notes',
          minBytes: 600,
          extraChecks: [
            {
              kind: 'contains',
              file: 'design/game-design.md',
              pattern: 'acceptance|criteria|checklist',
              flags: 'i',
              label: 'acceptance criteria',
            },
            {
              kind: 'contains',
              file: 'design/game-design.md',
              pattern: 'control|input|keyboard|mouse|touch',
              flags: 'i',
              label: 'control scheme',
            },
            {
              kind: 'contains',
              file: 'design/game-design.md',
              pattern: 'win|lose|game over|victory|defeat',
              flags: 'i',
              label: 'end-state rules',
            },
          ],
        },
      },
      {
        id: 'visual-design',
        name: 'Visual design',
        role: 'visual-designer',
        summary: 'palette, shapes/sprites, layout, juice',
        prompt:
          'Read artifact `design/game-design.md` with `read_artifact`, then decide how the game LOOKS. Pick a palette with exact color values, the canvas shapes or sprites for player/enemies/projectiles, the HUD layout (score, lives or timer), and at least one feedback effect (hit flash, screen shake, or particles). Keep it self-contained — canvas drawing or CSS, no external asset downloads. Save the concrete visual target to artifact `design/visual-design.md` with `write_artifact`, and summarize the path in task notes. Still no game code.',
        produces: {
          path: 'design/visual-design.md',
          kind: 'markdown-notes',
          minBytes: 450,
          extraChecks: [
            {
              kind: 'contains',
              file: 'design/visual-design.md',
              pattern: '#[0-9a-f]{3,8}|rgb\\(|hsl\\(',
              flags: 'i',
              label: 'concrete palette',
            },
            {
              kind: 'contains',
              file: 'design/visual-design.md',
              pattern: 'HUD|score|lives|timer',
              flags: 'i',
              label: 'HUD design',
            },
          ],
        },
      },
      {
        id: 'build',
        name: 'Build',
        role: 'developer',
        summary: 'implement the game in one index.html',
        prompt:
          'Read artifacts `design/game-design.md` and `design/visual-design.md` with `read_artifact`. Implement the game in workspace `index.html` with `write_file` (inline CSS + JS) so it satisfies the acceptance criteria and matches the visual spec. Include a real game loop, real input handling, score/state, a visible win or lose state, and an in-page restart path. Keep it self-contained with no network assets. On a loop-back, fix only the gaps the reviewer named — do not regress criteria that already passed. `write_task_note` the workspace path and which criteria now pass.',
        produces: {
          path: 'index.html',
          kind: 'html-game',
          minBytes: 3200,
          extraChecks: [
            {
              kind: 'contains',
              file: 'index.html',
              pattern: 'game\\s*-?\\s*over|you\\s+(?:win|won|lose|lost)|victory|defeat',
              flags: 'i',
              label: 'visible end state',
            },
            {
              kind: 'contains',
              file: 'index.html',
              pattern: 'restart|play\\s*again|new\\s*game|try\\s*again',
              flags: 'i',
              label: 'restart path',
            },
          ],
        },
      },
    ],
    evaluate: {
      prompt:
        'Read workspace `index.html` with `read_file` and actually exercise the game. If a browser/QA capability is available, load it, play it, test restart, and watch the console for errors; otherwise trace the game loop, input listeners, end-state transition, and reset path in source. Check every criterion from artifact `design/game-design.md` and write PASS/FAIL per criterion.',
    },
  },
  {
    id: 'branding-website',
    name: 'Branding Website',
    role: 'project-starter',
    release: { version: '1.1.1', releasedAt: '2026-08-14T00:00:00Z' },
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
          'Lock the visual language before a line of HTML exists. Decide: palette (with exact hex values), type pairing using system-safe fonts, spacing/scale, hero treatment, and responsive section order. Produce an ASCII/markdown wireframe of each section (hero, value props, proof or fit, CTA, footer). Write an **acceptance-criteria checklist** that includes the brand rules ("headings use <font>", "palette is exactly <hex list>", "hero matches the mock"). Save the full system, wireframe, and checklist to artifact `design/brand-system.md` with `write_artifact`; note the path in task notes. No HTML yet.',
        produces: {
          path: 'design/brand-system.md',
          kind: 'markdown-notes',
          minBytes: 800,
          extraChecks: [
            {
              kind: 'contains',
              file: 'design/brand-system.md',
              pattern: '#[0-9a-f]{6}',
              flags: 'i',
              label: 'exact palette',
            },
            {
              kind: 'contains',
              file: 'design/brand-system.md',
              pattern:
                'hero[\\s\\S]*(?:value|benefit)[\\s\\S]*(?:CTA|call.to.action)[\\s\\S]*footer',
              flags: 'i',
              label: 'section wireframe',
            },
          ],
        },
      },
      {
        id: 'copy',
        name: 'Copywriting',
        role: 'copywriter',
        summary: 'headlines + section copy to the brand voice',
        prompt:
          'Read artifact `design/brand-system.md` with `read_artifact`. Write the approved words: headline, subhead, three value-prop blurbs, proof or fit copy, CTA label, and footer. Match the named brand voice and keep it tight — marketing copy, not paragraphs. Save the complete section-keyed copy to artifact `copy/site-copy.md` with `write_artifact`; note the path in task notes so the build phase can drop it straight in.',
        produces: {
          path: 'copy/site-copy.md',
          kind: 'markdown-notes',
          minBytes: 450,
          extraChecks: [
            {
              kind: 'contains',
              file: 'copy/site-copy.md',
              pattern: 'headline|hero',
              flags: 'i',
              label: 'hero copy',
            },
            {
              kind: 'contains',
              file: 'copy/site-copy.md',
              pattern: 'CTA|call.to.action',
              flags: 'i',
              label: 'call to action',
            },
          ],
        },
      },
      {
        id: 'build',
        name: 'Build',
        role: 'developer',
        summary: 'implement index.html to the locked design + copy',
        prompt:
          'Read artifacts `design/brand-system.md` and `copy/site-copy.md` with `read_artifact`. Implement workspace `index.html` with `write_file` (inline CSS) to the locked visual language and approved copy — do not redesign in code. Honor the exact palette, type, and section order from the mock; include viewport metadata, semantic sections, a working primary CTA, and a footer. Make it responsive and self-contained with no external assets. On a loop-back, fix only the named gaps. `write_task_note` the workspace path and which criteria now pass.',
        produces: {
          path: 'index.html',
          kind: 'html-marketing-site',
          minBytes: 3200,
          extraChecks: [
            {
              kind: 'contains',
              file: 'index.html',
              pattern: '<meta[^>]+name=["\']viewport["\']',
              flags: 'i',
              label: 'responsive viewport',
            },
            {
              kind: 'contains',
              file: 'index.html',
              pattern: '<footer\\b',
              flags: 'i',
              label: 'footer',
            },
          ],
        },
      },
    ],
    evaluate: {
      prompt:
        'Read workspace `index.html` with `read_file` and compare it with artifacts `design/brand-system.md` and `copy/site-copy.md` via `read_artifact`. Check the brand acceptance criteria specifically: does the palette match the locked hex list, the type match, the responsive section order match the mock, and the copy match what was approved? Render desktop and narrow layouts if you can. A site that works but ignores the locked visual language FAILS — loop back to build.',
    },
  },
  {
    id: 'image-set-index',
    name: 'Index & Describe an Image Set',
    release: { version: '1.2.1', releasedAt: '2026-08-14T00:00:00Z' },
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
          'Decide the index schema before describing anything. The final output is workspace `index.json` with an `images` array; define fields per image (filename, caption, tags, dominantColors, orientation, containsText, and qualityFlags), controlled vocabulary rules, and an **acceptance-criteria checklist** ("every source image has exactly one record", "captions are 1-2 sentences", "tags use a consistent vocabulary", "the JSON parses"). Save the schema + checklist to artifact `image-index/schema.md` with `write_artifact`; note the path in task notes.',
        produces: {
          path: 'image-index/schema.md',
          kind: 'markdown-notes',
          minBytes: 500,
          extraChecks: [
            {
              kind: 'contains',
              file: 'image-index/schema.md',
              pattern: 'filename[\\s\\S]*caption[\\s\\S]*tags',
              flags: 'i',
              label: 'core schema fields',
            },
            {
              kind: 'contains',
              file: 'image-index/schema.md',
              pattern: 'every|coverage|exactly one',
              flags: 'i',
              label: 'coverage criterion',
            },
          ],
        },
      },
      {
        id: 'describe',
        name: 'Describe each image',
        role: 'developer',
        summary: 'read each image, write structured descriptions',
        prompt:
          'Read artifact `image-index/schema.md` with `read_artifact`, then list the source image folder with workspace tools. For each image, use the available image-reading or description capability to populate the schema. If the user supplied an authoritative metadata sidecar because image binaries or vision are unavailable, read it with `read_file`, preserve only its facts, and record that limitation. Keep vocabulary consistent and do not skip or invent images. Stage the complete per-image array as valid workspace JSON at `work/image-descriptions.json` with `write_file`.',
        produces: {
          path: 'work/image-descriptions.json',
          kind: 'json',
          minBytes: 300,
          extraChecks: [
            {
              kind: 'contains',
              file: 'work/image-descriptions.json',
              pattern: '"filename"[\\s\\S]*"caption"[\\s\\S]*"tags"',
              flags: 'i',
              label: 'per-image fields',
            },
          ],
        },
      },
      {
        id: 'assemble',
        name: 'Assemble the index',
        role: 'developer',
        summary: 'write the index file in the chosen format',
        prompt:
          'Read workspace `work/image-descriptions.json` with `read_file`, reconcile it against the complete source-folder or sidecar listing, and write the final JSON object to workspace `index.json` with `write_file`. Ensure the `images` array has exactly one record per source filename, every required field is present, and vocabulary is consistent. On a loop-back, fix only the named gaps (missing/extra records, malformed JSON, inconsistent tags). `write_task_note` the index path and an explicit coverage count (records vs source images).',
        produces: {
          path: 'index.json',
          kind: 'json',
          minBytes: 500,
          extraChecks: [
            {
              kind: 'contains',
              file: 'index.json',
              pattern: '"images"\\s*:',
              flags: 'i',
              label: 'images array',
            },
          ],
        },
      },
    ],
    evaluate: {
      prompt:
        'Read workspace `index.json`, `work/image-descriptions.json`, and the source-folder listing with workspace tools, plus artifact `image-index/schema.md` with `read_artifact`. Check coverage and consistency: does every source image have exactly one record, do all required fields exist, do captions/tags follow the schema and a consistent vocabulary, and does the file parse? Spot-check descriptions against actual images when available. Write PASS/FAIL per criterion.',
    },
    finishPrompt:
      'Every criterion passed. Write a DONE summary: index path, format, image count, and a one-line note that coverage is complete and the schema is consistent.',
  },
  {
    id: 'content-deck',
    name: 'Slide Deck from Content',
    release: { version: '1.2.1', releasedAt: '2026-08-14T00:00:00Z' },
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
          'Read every supplied source file with workspace `read_file` before outlining. Build a source-grounded deck plan: a title slide, a clear narrative arc, 5-7 content slides with one idea and 2-4 bullets each, and a takeaways/CTA ending. Attach a source filename or source heading to every factual claim. Write an **acceptance-criteria checklist** ("opens with a title slide", "one idea per slide", "ends with takeaways/CTA", "every claim traces to the source"). Save the outline + checklist to artifact `deck/outline.md` with `write_artifact`; note the path in task notes.',
        produces: {
          path: 'deck/outline.md',
          kind: 'markdown-notes',
          minBytes: 700,
          extraChecks: [
            {
              kind: 'contains',
              file: 'deck/outline.md',
              pattern: 'title slide|slide 1',
              flags: 'i',
              label: 'title slide',
            },
            {
              kind: 'contains',
              file: 'deck/outline.md',
              pattern: 'takeaway|CTA|call.to.action|recommendation',
              flags: 'i',
              label: 'closing slide',
            },
          ],
        },
      },
      {
        id: 'slide-design',
        name: 'Slide design',
        role: 'designer',
        summary: 'a consistent slide template + palette',
        prompt:
          'Read artifact `deck/outline.md` with `read_artifact`. Design one reusable slide system: title position, body/grid layout, exact palette, type scale, spacing, progress affordance, and focused/inactive slide states. Include desktop and narrow-screen behavior plus keyboard/button navigation treatment. Consistency matters more than flourish. Save the template spec to artifact `deck/design-system.md` with `write_artifact`; note the path in task notes. No slide content yet.',
        produces: {
          path: 'deck/design-system.md',
          kind: 'markdown-notes',
          minBytes: 500,
          extraChecks: [
            {
              kind: 'contains',
              file: 'deck/design-system.md',
              pattern: '#[0-9a-f]{3,8}|rgb\\(|hsl\\(',
              flags: 'i',
              label: 'concrete palette',
            },
            {
              kind: 'contains',
              file: 'deck/design-system.md',
              pattern: 'keyboard|arrow|previous|next|navigation',
              flags: 'i',
              label: 'navigation treatment',
            },
          ],
        },
      },
      {
        id: 'build',
        name: 'Build the deck',
        role: 'developer',
        summary: 'generate the slides to the template',
        prompt:
          'Read artifacts `deck/outline.md` and `deck/design-system.md` with `read_artifact`. Build the deck in workspace `index.html` with `write_file`: one semantic section per slide, inline CSS/JS, visible slide count/progress, previous/next controls, and ArrowLeft/ArrowRight keyboard navigation. Apply the template uniformly and use only claims in the outline/source. Keep it self-contained with no external assets. On a loop-back, fix only the named gaps. `write_task_note` the workspace path and slide count.',
        produces: {
          path: 'index.html',
          kind: 'slide-deck',
          minBytes: 3600,
          extraChecks: [
            { kind: 'htmlLint', file: 'index.html' },
            { kind: 'cssMinBytes', file: 'index.html', bytes: 700 },
            { kind: 'jsParses', file: 'index.html' },
            {
              kind: 'contains',
              file: 'index.html',
              pattern: 'ArrowLeft|ArrowRight|keydown',
              label: 'keyboard navigation',
            },
          ],
        },
      },
    ],
    evaluate: {
      prompt:
        'Read workspace `index.html` with `read_file` and artifacts `deck/outline.md` and `deck/design-system.md` with `read_artifact`. Check narrative flow (title opening, one idea per slide, takeaways ending), visual consistency, source fidelity, and both button and keyboard navigation. Render and exercise it if browser QA is available; otherwise trace the event handlers. Write PASS/FAIL per criterion.',
    },
  },
  {
    id: 'corpus-email-digest',
    name: 'Daily Email Digest from a Corpus',
    release: { version: '1.2.1', releasedAt: '2026-08-14T00:00:00Z' },
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
          'List and read every supplied corpus file with workspace tools before scoping. Decide the digest window, included sources, section structure (headline, top items, one line each), target length, tone, citation format, and subject-line convention. Write an **acceptance-criteria checklist** ("≤ N items per section", "every item cites its source", "scannable in under a minute", "no item outside the window", "no invented facts"). Save the scope + checklist to artifact `digest/scope.md` with `write_artifact`; note the path in task notes.',
        produces: {
          path: 'digest/scope.md',
          kind: 'markdown-notes',
          minBytes: 500,
          extraChecks: [
            {
              kind: 'contains',
              file: 'digest/scope.md',
              pattern: 'citation|source',
              flags: 'i',
              label: 'citation policy',
            },
            {
              kind: 'contains',
              file: 'digest/scope.md',
              pattern: 'window|fresh|date',
              flags: 'i',
              label: 'freshness window',
            },
          ],
        },
      },
      {
        id: 'draft',
        name: 'Draft the digest',
        role: 'copywriter',
        summary: 'write the digest from the corpus, with citations',
        prompt:
          'Read artifact `digest/scope.md` with `read_artifact`, then re-read every included corpus source with workspace `read_file`. Write the digest to the scoped structure: a subject line, one tight line per item, and an adjacent source filename/citation for every item. Lead with what matters, keep a consistent voice, and do not invent or merge unsupported facts. Save the complete draft to artifact `digest/draft.md` with `write_artifact`; note the path in task notes.',
        produces: {
          path: 'digest/draft.md',
          kind: 'markdown-doc',
          artifact: true,
          minBytes: 700,
          extraChecks: [
            {
              kind: 'contains',
              file: 'digest/draft.md',
              pattern: 'subject\\s*:',
              flags: 'i',
              label: 'subject line',
            },
            {
              kind: 'contains',
              file: 'digest/draft.md',
              pattern: '\\.md\\b|source\\s*:',
              flags: 'i',
              label: 'source citations',
            },
          ],
        },
      },
      {
        id: 'build',
        name: 'Build the email output',
        role: 'developer',
        summary: 'render to an email-ready format',
        prompt:
          'Read artifacts `digest/scope.md` and `digest/draft.md` with `read_artifact`. Render the approved draft to workspace `digest.html` with `write_file`. Include the subject line in visible/preheader content, preserve every adjacent source citation, use semantic email-safe tables or blocks, and keep styles inline or in a small embedded style block with no external CSS, scripts, or network assets. On a loop-back, fix only the named gaps. `write_task_note` the workspace output path and item/source counts.',
        produces: {
          path: 'digest.html',
          kind: 'html-page',
          minBytes: 2200,
          extraChecks: [
            { kind: 'cssMinBytes', file: 'digest.html', bytes: 350 },
            {
              kind: 'contains',
              file: 'digest.html',
              pattern: 'subject\\s*:',
              flags: 'i',
              label: 'subject line',
            },
            {
              kind: 'contains',
              file: 'digest.html',
              pattern: '\\.md\\b|source\\s*:',
              flags: 'i',
              label: 'source citations',
            },
          ],
        },
      },
    ],
    evaluate: {
      prompt:
        'Read workspace `digest.html` with `read_file`, artifacts `digest/scope.md` and `digest/draft.md` with `read_artifact`, and the original corpus files with workspace tools. Check accuracy (every item traces to a corpus fact, nothing invented), citations (each item names its source), scannability, section/item limits, and freshness window. Confirm the HTML preserves the approved draft and has no external dependencies. Write PASS/FAIL per criterion.',
    },
  },
];
