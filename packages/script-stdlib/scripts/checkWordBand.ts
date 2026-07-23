import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, wordBand, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkWordBand',
  description:
    "Gate: a file's word count is within [min, max] — floors AND ceilings, because verbosity is a failure mode too. Markdown markup (code fences, links, emphasis) is excluded from the count by default.",
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    min: {
      type: 'number',
      description: 'Minimum word count (omit for no floor).',
      integer: true,
      min: 0,
    },
    max: {
      type: 'number',
      description: 'Maximum word count (omit for no ceiling).',
      integer: true,
      min: 0,
    },
    stripMarkdown: {
      type: 'boolean',
      description: 'Exclude Markdown markup from the count.',
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
if (content === null) {
  gezel.output(
    gateResult(false, `${input.file} not found — write the deliverable before advancing.`),
  );
} else if (input.min === undefined && input.max === undefined) {
  gezel.output(gateResult(false, 'No band configured — set "min" and/or "max".'));
} else {
  const r = wordBand(content, {
    min: input.min,
    max: input.max,
    stripMarkdown: input.stripMarkdown,
  });
  gezel.output(gateResult(r.ok, `${input.file}: ${r.detail}`));
}
