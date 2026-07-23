import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, standaloneJsParses, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkStandaloneJsParses',
  description:
    'Gate: a standalone .js/.mjs source file parses as JavaScript (imports/exports stripped, then V8-parsed) — catches truncated files and unbalanced braces that a byte floor waves through. TypeScript files need the declarative sourceParses gate check instead.',
  kind: 'gate',
  inputs: {
    file: {
      type: 'string',
      description: 'Workspace-relative source file to check.',
      required: true,
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
  const r = standaloneJsParses(content, input.file);
  gezel.output(gateResult(r.ok, r.detail));
}
