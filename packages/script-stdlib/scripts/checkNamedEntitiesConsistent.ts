import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  type EntitySpec,
  gateResult,
  namedEntitiesConsistent,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkNamedEntitiesConsistent',
  description:
    'Gate: a long document refers to each named entity consistently — no declared drifted spelling/numbering (e.g. "ACME Corporation" when the canonical form is "Acme Corp") appears anywhere. Case-sensitive.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    entities: {
      type: 'json',
      description:
        'Array of [{ canonical, variants: string[] }]. The gate rejects if any variant appears in the file.',
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
  const entities = (Array.isArray(input.entities) ? input.entities : []) as EntitySpec[];
  const r = namedEntitiesConsistent(content, entities);
  gezel.output(gateResult(r.ok, `${input.file}: ${r.detail}`));
}
