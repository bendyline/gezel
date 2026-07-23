import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, planStructure, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkPlanStructure',
  description:
    "Gate: the plan's first Markdown table has ID | Task | Owner | Depends on | Done when columns, owners on the roster, dependencies that resolve without cycles (earlier rows only by default), and checkable done-states.",
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative plan file.', required: true },
    minRows: {
      type: 'number',
      description: 'Minimum number of plan rows.',
      default: 1,
      integer: true,
      min: 0,
    },
    ownerRoster: {
      type: 'json',
      description: 'Optional array of allowed Owner names (case-insensitive).',
    },
    requireEarlierOnly: {
      type: 'boolean',
      description: 'Rows may only depend on earlier rows (default true).',
    },
    doneWhenMinChars: {
      type: 'number',
      description: 'Minimum "Done when" cell length (default 12).',
      integer: true,
      min: 1,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the named row + cell to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const content = await workspaceFromGezel(gezel).read(input.file);
if (content === null) {
  gezel.output(gateResult(false, `${input.file} not found — write the plan before advancing.`));
} else {
  const ownerRoster = Array.isArray(input.ownerRoster) ? input.ownerRoster.map(String) : undefined;
  const result = planStructure(content, {
    ...(input.minRows !== undefined ? { minRows: input.minRows } : {}),
    ...(ownerRoster ? { ownerRoster } : {}),
    ...(input.requireEarlierOnly !== undefined
      ? { requireEarlierOnly: input.requireEarlierOnly }
      : {}),
    ...(input.doneWhenMinChars !== undefined ? { doneWhenMinChars: input.doneWhenMinChars } : {}),
  });
  gezel.output(
    gateResult(
      result.ok,
      result.ok
        ? `${input.file}: plan table valid (${result.rows.length} rows; owners + dependencies + done-states check out).`
        : `${input.file}: ${result.detail}`,
    ),
  );
}
