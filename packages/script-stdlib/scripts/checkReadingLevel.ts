import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, readingLevel, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkReadingLevel',
  description:
    "Gate: a file's readability sits within a band — Flesch-Kincaid grade (minGrade/maxGrade) and/or Flesch reading-ease (minEase/maxEase). Heuristic; pairs well as an advisory comms gate.",
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    minGrade: { type: 'number', description: 'Minimum Flesch-Kincaid grade level.' },
    maxGrade: {
      type: 'number',
      description: 'Maximum Flesch-Kincaid grade level (cap complexity).',
    },
    minEase: { type: 'number', description: 'Minimum Flesch reading-ease (higher = easier).' },
    maxEase: { type: 'number', description: 'Maximum Flesch reading-ease.' },
    stripMarkdown: {
      type: 'boolean',
      description: 'Exclude Markdown markup before scoring.',
      default: true,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const content = await workspaceFromGezel(gezel).read(input.file);
const banded =
  input.minGrade !== undefined ||
  input.maxGrade !== undefined ||
  input.minEase !== undefined ||
  input.maxEase !== undefined;
if (content === null) {
  gezel.output(
    gateResult(false, `${input.file} not found — write the deliverable before advancing.`),
  );
} else if (!banded) {
  gezel.output(
    gateResult(false, 'No band configured — set at least one of min/maxGrade or min/maxEase.'),
  );
} else {
  const r = readingLevel(content, {
    minGrade: input.minGrade,
    maxGrade: input.maxGrade,
    minEase: input.minEase,
    maxEase: input.maxEase,
    stripMarkdown: input.stripMarkdown,
  });
  gezel.output(gateResult(r.ok, `${input.file}: ${r.detail}`));
}
