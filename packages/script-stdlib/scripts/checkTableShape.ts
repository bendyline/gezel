import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  type CellType,
  gateResult,
  tableShape,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkTableShape',
  description:
    'Gate: the first Markdown table in a file has the required columns, a minimum row count, and (optionally) typed columns — e.g. an action-item table with an owner column and ≥ 3 rows.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Workspace-relative file to check.', required: true },
    requiredColumns: {
      type: 'json',
      description: 'Array of header names that must be present (case-insensitive).',
    },
    minRows: {
      type: 'number',
      description: 'Minimum number of body rows.',
      default: 1,
      integer: true,
      min: 0,
    },
    columnTypes: {
      type: 'json',
      description:
        'Optional { column: type } map. Type is one of number/integer/boolean/date/iso-date/email/nonempty, or a regex source.',
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
  const requiredColumns = Array.isArray(input.requiredColumns)
    ? input.requiredColumns.map(String)
    : undefined;
  const columnTypes =
    input.columnTypes && typeof input.columnTypes === 'object' && !Array.isArray(input.columnTypes)
      ? (input.columnTypes as Record<string, CellType>)
      : undefined;
  const r = tableShape(content, { requiredColumns, minRows: input.minRows, columnTypes });
  gezel.output(gateResult(r.ok, r.detail));
}
