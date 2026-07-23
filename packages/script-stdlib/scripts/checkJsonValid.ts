import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, jsonValid, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkJsonValid',
  description: 'Gate: a workspace file parses as valid JSON.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'JSON file to check.', required: true },
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
  const r = jsonValid(content);
  gezel.output(
    gateResult(
      r.ok,
      r.ok
        ? `${input.file} is valid JSON`
        : `${input.file} is not valid JSON: ${r.error ?? 'parse error'}. Fix the syntax and re-advance.`,
    ),
  );
}
