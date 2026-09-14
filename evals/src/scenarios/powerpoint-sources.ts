/**
 * The PowerPoint route across every SOURCE SHAPE it claims to accept.
 *
 * `craftbook-powerpoint-deck` (the book's own `test.json`) proves exactly one
 * of them: a Markdown file named in `sourcePath`. That is branch 1 of the
 * research step, and it was the only branch under test while two consecutive
 * production failures — "Can you create a PowerPoint about France" and the
 * same for Valencia — happened in branch 2, the topic-only path, where
 * `sourcePath` and `content` are both empty. A book whose first step forks on
 * its inputs needs an eval per fork, or half the recipe ships unverified.
 *
 * Five scenarios, one fact set, one book:
 *
 *   pptx-source-docx    a real Word container — must open with read_doc_as_markdown
 *   pptx-source-pdf     a real PDF container — same, different extractor
 *   pptx-source-inline  facts arrive in `content`, no file at all
 *   pptx-topic-only     no source of any kind; the honest-skip attestation is
 *                       the pass condition, and stalling is the failure
 *   pptx-source-decoy   a named source PLUS a plausible wrong one beside it
 *
 * All five run the real craftbook task (`mode: 'workflow'`) against the
 * deterministic DocBlocks mock the book already ships, so a trial measures the
 * model and the runtime rather than the conversion toolchain. The real
 * DocBlocks boundary is a separate, slower rail — see docblocks-integration.ts.
 */

import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import type { CraftbookEvalGateCheck, CraftbookEvalSpec } from '../craftbooks/types.ts';
import {
  type DocumentBlock,
  buildDocx,
  buildMarkdown,
  buildPdf,
} from '../fixtures/office-documents.ts';
import type { EvalScenario } from '../types.ts';

/**
 * Invented on purpose. Every figure here is checkable and none of it is
 * recallable: a model that pattern-matches its way to plausible ferry
 * statistics fails `valueGrounding` instead of quietly passing on memory.
 */
const BRIEF_BLOCKS: readonly DocumentBlock[] = [
  { style: 'h1', text: 'Halvard Terminal — Winter Boarding Pilot' },
  {
    style: 'p',
    text: 'Audience: terminal operations leads. Reporting period: the 2025-26 winter timetable.',
  },
  { style: 'h2', text: 'Scope' },
  { style: 'bullet', text: 'Pilot ran across 4 berths at Halvard Terminal.' },
  { style: 'bullet', text: 'Covered 1,180 scheduled winter sailings.' },
  { style: 'h2', text: 'Measured results' },
  { style: 'bullet', text: 'Mean boarding time fell from 21.4 minutes to 12.8 minutes.' },
  { style: 'bullet', text: 'Missed-sailing rate fell from 6.7% to 2.1%.' },
  { style: 'bullet', text: 'Wheelchair-assist wait fell from 14 minutes to 5 minutes.' },
  { style: 'h2', text: 'Unresolved' },
  { style: 'bullet', text: 'Top unresolved complaint: no audible announcement on Berth 3.' },
  { style: 'h2', text: 'Next actions' },
  { style: 'bullet', text: 'Install the Berth 3 audio loop.' },
  { style: 'bullet', text: 'Publish a winter timetable card.' },
  { style: 'bullet', text: 'Staff a second gangway marshal at 07:00.' },
  { style: 'p', text: 'Do not invent other metrics.' },
];

const BRIEF_MARKDOWN = buildMarkdown(BRIEF_BLOCKS);

/**
 * A decoy that is wrong in every way that matters and right in every way that
 * tempts: same document shape, same audience, adjacent name, different
 * terminal and different numbers. The book's research step says never to
 * replace a named source with a similarly named file; this is the file.
 */
const DECOY_BLOCKS: readonly DocumentBlock[] = [
  { style: 'h1', text: 'Kelby Terminal — Summer Boarding Pilot' },
  {
    style: 'p',
    text: 'Audience: terminal operations leads. Reporting period: the 2025 summer timetable.',
  },
  { style: 'bullet', text: 'Pilot ran across 9 berths at Kelby Terminal.' },
  { style: 'bullet', text: 'Mean boarding time fell from 33.9 minutes to 27.2 minutes.' },
  { style: 'bullet', text: 'Missed-sailing rate fell from 11.5% to 9.4%.' },
  { style: 'bullet', text: 'Next actions: repaint the berth numbers, extend the kiosk hours.' },
];

/**
 * Figures that must survive into the deck, and the decoy figures that must not.
 *
 * `required` is an OR: at least one authorized value for the fact has to
 * appear. The variants are deliberate — the gate is testing GROUNDING, not
 * copy-editing, so a slide that writes "four berths" or "14 min" is quoting
 * the source just as faithfully as one that writes "4 berths". Pinning a
 * single surface form would fail honest work and teach nothing. The decimals
 * carry no variants because there is only one way to write them and they are
 * the values no model could have guessed.
 */
const HALVARD_FACTS = [
  { id: 'berths', label: 'pilot berth count', required: ['4 berths', 'four berths'] },
  { id: 'boarding', label: 'boarding time', required: ['21.4', '12.8'] },
  { id: 'missed', label: 'missed-sailing rate', required: ['6.7', '2.1'] },
  {
    id: 'assist',
    label: 'wheelchair-assist wait',
    required: ['14 minutes', '14 min', '5 minutes', '5 min'],
  },
];

const DECOY_FIGURES = ['Kelby', '33.9', '27.2', '11.5', '9.4', '9 berths'];

const OUTPUT_DIR = 'powerpoint/eval';
const DECK_MD = `${OUTPUT_DIR}/deck.md`;
const DECK_PPTX = 'deliverables/halvard-pilot.pptx';

/** Gates every variant shares: the packet, the outline, the deck, the binary. */
function commonDeliverables(opts: {
  /** Topic-only runs may honestly have nothing to cite. */
  citations: 'required' | 'or-attestation';
}): CraftbookEvalSpec['success']['deliverables'] {
  const sourcesChecks: CraftbookEvalGateCheck[] =
    opts.citations === 'required'
      ? [
          {
            kind: 'citationsResolve',
            file: '{{task.dir}}/sources.md',
            artifact: true,
            minCitations: 1,
          },
        ]
      : [
          // The book's own escape hatch, quoted back at it. An honest
          // attestation satisfies step 4 exactly as a citation does — the
          // pass condition is that the workflow SAYS SO and continues, not
          // that it found a source. Stalling here is the failure this
          // scenario exists to catch.
          {
            kind: 'contains',
            file: '{{task.dir}}/sources.md',
            artifact: true,
            // Match the ASSERTION, not one surface form of it. The book asks
            // for "research status (`completed` or `skipped`, with reason)"
            // and a model that writes
            //     ## Research Status
            //     **Status:** Skipped — no citable sources available (reason: …)
            // has complied exactly. A flat-line pattern failed that, which is
            // the gate inventing a formatting rule the procedure never set.
            pattern: 'research\\s*status[\\s\\S]{0,80}?(?:skipped|completed)',
            flags: 'i',
            label: 'an explicit research-status line',
          },
        ];
  return [
    {
      path: '{{task.dir}}/sources.md',
      kind: 'markdown-doc',
      minBytes: 300,
      artifact: true,
      checks: sourcesChecks,
    },
    {
      path: '{{task.dir}}/outline.md',
      kind: 'markdown-doc',
      minBytes: 300,
      artifact: true,
      checks: [
        {
          kind: 'contains',
          file: '{{task.dir}}/outline.md',
          artifact: true,
          pattern: '(?:^|\\n)#{2,6}\\s+(?:Slide\\s+)?1(?:\\s*[.:\\-–—]\\s*|\\s+)\\S',
          flags: 'i',
          label: 'a numbered Slide 1 heading',
        },
      ],
    },
    {
      path: DECK_MD,
      kind: 'markdown-doc',
      minBytes: 500,
      checks: [
        {
          kind: 'markdownHeadingsMatch',
          file: DECK_MD,
          outlineFile: '{{task.dir}}/outline.md',
          outlineArtifact: true,
        },
        { kind: 'notContains', file: DECK_MD, pattern: '<html|<script|<style', flags: 'i' },
      ],
    },
    {
      path: DECK_PPTX,
      kind: 'slide-deck',
      minBytes: 1000,
      checks: [{ kind: 'binaryDocument', file: DECK_PPTX, minBytes: 1000 }],
    },
  ];
}

/** The deck must carry the supplied figures and invent none. */
function groundingCheck(forbidden?: readonly string[]): CraftbookEvalGateCheck {
  return {
    kind: 'valueGrounding',
    file: DECK_MD,
    facts: HALVARD_FACTS.map((fact) => ({
      ...fact,
      ...(forbidden ? { forbidden: [...forbidden] } : {}),
    })),
  };
}

interface VariantOptions {
  scenarioId: string;
  title: string;
  objective: string;
  prompt: string;
  craftbookParams: Record<string, string>;
  files: CraftbookEvalSpec['setup'] extends infer S
    ? S extends { files?: infer F }
      ? F
      : never
    : never;
  /** Extra success checks beyond the shared deliverables. */
  checks?: CraftbookEvalGateCheck[];
  /** Runtime-behaviour evidence from the append-only project History. */
  history?: NonNullable<CraftbookEvalSpec['success']['history']>;
  citations?: 'required' | 'or-attestation';
  qualityFocus: string[];
  /** Topic-only variants have no source document to match against. */
  grounded?: boolean;
  forbidden?: readonly string[];
}

function variant(source: CraftbookEvalSpec, opts: VariantOptions): CraftbookEvalSpec {
  const deliverables = commonDeliverables({ citations: opts.citations ?? 'required' });
  const deckDeliverable = deliverables?.find((d) => d.path === DECK_MD);
  if (opts.grounded !== false && deckDeliverable) {
    deckDeliverable.checks = [...(deckDeliverable.checks ?? []), groundingCheck(opts.forbidden)];
  }
  return {
    ...source,
    scenarioId: opts.scenarioId,
    title: opts.title,
    objective: opts.objective,
    mode: 'workflow',
    // Watch the book's own gates work. A harness repair turn would paper over
    // exactly the step-level stalls these scenarios are built to find.
    repairPolicy: 'runtime',
    prompt: opts.prompt,
    setup: {
      ...source.setup!,
      projectName: `PowerPoint Sources — ${opts.scenarioId}`,
      about:
        'A single supplied brief is authoritative. The deck must keep the locked outline and the supplied figures exactly.',
      missionObjectives: opts.prompt,
      craftbookParams: {
        outputPath: DECK_PPTX,
        outputDir: OUTPUT_DIR,
        audience: 'terminal operations leads',
        ...opts.craftbookParams,
      },
      files: opts.files,
    },
    success: {
      summary: opts.objective,
      deliverables,
      checks: opts.checks ?? [],
      mocks: source.success.mocks,
      ...(opts.history ? { history: opts.history } : {}),
      taskGraph: { requireCraftbookTask: true, requireTerminalStep: true },
    },
    coverage: {
      status: 'implemented',
      validatedMode: 'workflow',
      notes: `Source-shape variant of the powerpoint-deck book: ${opts.objective}`,
    },
    qualityFocus: opts.qualityFocus,
  };
}

/**
 * `read_doc_as_markdown` is the only correct opener for a binary source, and
 * the proof is the project History event the MCP bridge writes when it
 * succeeds.
 *
 * NOT `researchEvidence`: that kind is evaluable only inside the task
 * manager's gate path, which injects a live tool-call evidence provider. The
 * scenario grader has no provider and the check fails closed on every trial —
 * it would have made all four binary-source scenarios permanently unpassable.
 */
function binarySourceEvidence(): NonNullable<CraftbookEvalSpec['success']['history']> {
  return [{ kind: 'tool.called', details: { name: 'read_doc_as_markdown', success: true } }];
}

export function powerpointSourceSpecs(): CraftbookEvalSpec[] {
  const source = craftbookEvalSpecMap().get('powerpoint-deck');
  if (!source) throw new Error('Missing powerpoint-deck craftbook spec');

  const docxBytes = Buffer.from(buildDocx(BRIEF_BLOCKS)).toString('base64');
  const pdfBytes = Buffer.from(buildPdf(BRIEF_BLOCKS)).toString('base64');
  const decoyDocx = Buffer.from(buildDocx(DECOY_BLOCKS)).toString('base64');

  const deckBrief =
    'Build the deck in 6-8 slides for terminal operations leads, preserve the supplied figures exactly, invent no other metrics, and close with the supplied next actions. Do not produce HTML.';

  return [
    variant(source, {
      scenarioId: 'pptx-source-docx',
      title: 'PowerPoint from a Word source',
      objective:
        'A .docx named in sourcePath is opened with read_doc_as_markdown, its figures survive into the deck, and a real PPTX is saved.',
      prompt: `Create a PowerPoint from source/halvard-brief.docx. ${deckBrief}`,
      craftbookParams: {
        sourcePath: 'source/halvard-brief.docx',
        topic: 'Halvard Terminal winter boarding pilot',
        content: '',
      },
      files: [
        {
          path: 'source/halvard-brief.docx',
          content: BRIEF_MARKDOWN,
          contentBase64: docxBytes,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
      history: binarySourceEvidence(),
      qualityFocus: [
        'binary source opened with the document reader, not read_file',
        'figures preserved verbatim from a non-text container',
      ],
    }),

    variant(source, {
      scenarioId: 'pptx-source-pdf',
      title: 'PowerPoint from a PDF source',
      objective:
        'A .pdf named in sourcePath is opened with read_doc_as_markdown, its figures survive into the deck, and a real PPTX is saved.',
      prompt: `Create a PowerPoint from source/halvard-brief.pdf. ${deckBrief}`,
      craftbookParams: {
        sourcePath: 'source/halvard-brief.pdf',
        topic: 'Halvard Terminal winter boarding pilot',
        content: '',
      },
      files: [
        {
          path: 'source/halvard-brief.pdf',
          content: BRIEF_MARKDOWN,
          contentBase64: pdfBytes,
          mimeType: 'application/pdf',
        },
      ],
      history: binarySourceEvidence(),
      qualityFocus: [
        'PDF text extraction feeds the fact ledger',
        'no fabricated figures when extraction is lossy',
      ],
    }),

    variant(source, {
      scenarioId: 'pptx-source-inline',
      title: 'PowerPoint from inline content',
      objective:
        'Facts supplied inline in `content` (no file anywhere) are treated as the authoritative source and reach the deck intact.',
      prompt: `Create a PowerPoint from the brief I gave you. ${deckBrief}`,
      craftbookParams: {
        sourcePath: '',
        topic: 'Halvard Terminal winter boarding pilot',
        content: BRIEF_MARKDOWN,
      },
      files: [],
      // Nothing to read: the supplied content IS the source, so demanding a
      // read tool here would fail the correct behavior.
      citations: 'or-attestation',
      qualityFocus: [
        'inline content recognized as supplied source',
        'no hunt for a file that was never named',
      ],
    }),

    variant(source, {
      scenarioId: 'pptx-topic-only',
      title: 'PowerPoint from a topic with no research surface',
      objective:
        'A topic-only run with no source and no research tools writes the honest research-status attestation and still ships the deck, instead of stalling on the missing source.',
      prompt:
        'Can you create a PowerPoint about the Halvard Terminal winter boarding pilot? Use 6-8 slides for terminal operations leads. Do not produce HTML.',
      craftbookParams: {
        sourcePath: '',
        content: '',
        topic: 'Can you create a PowerPoint about the Halvard Terminal winter boarding pilot',
      },
      files: [],
      citations: 'or-attestation',
      // No source document exists, so there are no supplied figures to
      // conserve — the deck is honest original content by construction.
      grounded: false,
      qualityFocus: [
        'topic-only branch reaches the deck at all',
        'unsourced content framed as original, not as established fact',
        'no stall waiting for a source that was never supplied',
      ],
    }),

    variant(source, {
      scenarioId: 'pptx-source-decoy',
      title: 'PowerPoint with a plausible wrong source beside the right one',
      objective:
        'The named source wins over an adjacent, similarly-shaped brief and a stale deck from another subject; none of the decoy figures reach the deck.',
      prompt: `Create a PowerPoint from source/halvard-brief.docx. ${deckBrief}`,
      craftbookParams: {
        sourcePath: 'source/halvard-brief.docx',
        topic: 'Halvard Terminal winter boarding pilot',
        content: '',
      },
      files: [
        {
          path: 'source/halvard-brief.docx',
          content: BRIEF_MARKDOWN,
          contentBase64: docxBytes,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        // Every decoy is `modelInput: false`. They are seeded on disk and
        // remain discoverable (list_dir, search, a wrong `read_file`), which
        // is the whole temptation — but they are NOT this run's source, so
        // the harness must not demand they be read. Without the flag the
        // scenario contradicts itself: it seeds files the model must ignore
        // and then fails the trial for ignoring them, which is exactly what
        // happened on its first run (13/14, "seeded workspace input(s) have
        // not been read yet: source/kelby-brief.docx, notes/outline.md" — on
        // a deck that had correctly used none of them).
        {
          path: 'source/kelby-brief.docx',
          content: buildMarkdown(DECOY_BLOCKS),
          contentBase64: decoyDocx,
          modelInput: false,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        // The two files the book's own step prompt warns its assignee away
        // from, present and stale, exactly as they were in the workshop
        // project where the wrong-topic conversions happened.
        {
          path: 'notes/outline.md',
          content: buildMarkdown(DECOY_BLOCKS),
          modelInput: false,
        },
        {
          path: 'deck.md',
          content:
            '# Kelby Terminal — Summer Boarding Pilot\n\nStale deck from a previous job. Not an input.\n',
          modelInput: false,
        },
      ],
      history: binarySourceEvidence(),
      forbidden: DECOY_FIGURES,
      qualityFocus: [
        'exact named source beats an adjacent similarly-named file',
        'stale workspace decks are not reused as inputs',
      ],
    }),
  ];
}

export function powerpointSourceScenarios(): EvalScenario[] {
  return powerpointSourceSpecs().map((spec) => craftbookScenarioFromSpec(spec));
}
