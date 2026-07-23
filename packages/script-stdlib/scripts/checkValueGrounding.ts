import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  type GroundingFact,
  gateResult,
  valueGrounding,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkValueGrounding',
  description:
    "Gate: named facts are grounded in authorized sources — each fact's required value(s) must appear and its forbidden (decoy) value(s) must not. Digit-grouping tolerant. Ported from the decoy-research grader.",
  kind: 'gate',
  inputs: {
    file: {
      type: 'string',
      description: 'Workspace-relative deliverable to check.',
      required: true,
    },
    facts: {
      type: 'json',
      description:
        'Array of facts: [{ id, label?, required: string[], forbidden?: string[] }]. Values are regex sources matched case-insensitively; a fact passes when ANY required form matches and NO forbidden form does.',
      required: true,
    },
    normalizeDigits: {
      type: 'boolean',
      description: 'Collapse digit-grouping so "4,217,300" matches /4217300/.',
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
} else {
  const facts = (Array.isArray(input.facts) ? input.facts : []) as GroundingFact[];
  const r = valueGrounding(content, facts, { normalizeDigits: input.normalizeDigits });
  gezel.output(gateResult(r.ok, r.detail));
}
