import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  type RecordFieldSpec,
  gateResult,
  recordSchema,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkRecordSchema',
  description:
    "Gate: a JSON-array or CSV deliverable's rows validate against a declared field schema (types, required fields, no extras, row floor, uniqueness). Stops at the first failing record. Ported from the data-wrangle grader.",
  kind: 'gate',
  inputs: {
    file: {
      type: 'string',
      description: 'Workspace-relative records file (JSON or CSV).',
      required: true,
    },
    fields: {
      type: 'json',
      description:
        'Array of field specs: [{ name, type?, required? }]. type ∈ string/number/integer/boolean/date/iso-date/email/nonempty or a regex source; required defaults to true.',
      required: true,
    },
    allowExtraFields: {
      type: 'boolean',
      description: 'Permit fields not named in the schema.',
      default: false,
    },
    minRows: { type: 'number', description: 'Minimum record count.', integer: true, min: 0 },
    uniqueBy: { type: 'string', description: 'Field whose values must be unique across rows.' },
    format: {
      type: 'choice',
      description: 'Input format. Defaults to auto (sniff JSON vs CSV).',
      options: [{ value: 'auto' }, { value: 'json' }, { value: 'csv' }],
      default: 'auto',
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
const fields = (Array.isArray(input.fields) ? input.fields : []) as RecordFieldSpec[];
const r = recordSchema(content, {
  fields,
  allowExtraFields: input.allowExtraFields,
  minRows: input.minRows,
  uniqueBy: input.uniqueBy,
  format: input.format as 'auto' | 'json' | 'csv' | undefined,
});
gezel.output(gateResult(r.ok, r.detail));
