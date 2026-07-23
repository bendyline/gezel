import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkFileExists',
  description:
    'Gate: a file exists (and is non-empty) in the project workspace or the artifacts area.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Relative path of the file.', required: true },
    area: {
      type: 'choice',
      description: 'Where to look.',
      options: [{ value: 'workspace' }, { value: 'artifacts' }],
      default: 'workspace',
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read', 'artifacts.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
let content: string | null = null;
try {
  content =
    input.area === 'artifacts'
      ? await gezel.artifacts.read(input.file)
      : await gezel.fs.read(input.file);
} catch {
  content = null;
}
const ok = content !== null && content.trim().length > 0;
gezel.output(
  gateResult(
    ok,
    ok
      ? `${input.file} exists (${content?.length ?? 0} bytes)`
      : `${input.file} is missing or empty in the ${input.area ?? 'workspace'} area — create it before advancing.`,
  ),
);
