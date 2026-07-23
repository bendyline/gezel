import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { countDistinctMatches, gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkDistinctMatches',
  description:
    'Gate: a file contains at least N DISTINCT matches of a pattern (distinct by first capture group) — e.g. cites ≥ 4 different evidence files.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    pattern: {
      type: 'string',
      description: 'Regular expression; group 1 (if present) defines distinctness.',
      required: true,
    },
    flags: { type: 'string', description: 'Regex flags, e.g. "i".', default: 'gi' },
    min: {
      type: 'number',
      description: 'Minimum distinct matches.',
      required: true,
      integer: true,
      min: 1,
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
} else {
  const count = countDistinctMatches(content, new RegExp(input.pattern, input.flags ?? 'gi'));
  gezel.output(
    gateResult(
      count >= input.min,
      count >= input.min
        ? `${input.file} has ${count} distinct match(es) of /${input.pattern}/`
        : `${input.file} has ${count} distinct match(es) of /${input.pattern}/, need ≥ ${input.min}.`,
    ),
  );
}
