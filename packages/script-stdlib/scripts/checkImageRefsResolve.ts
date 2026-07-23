import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, imageRefsResolve, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkImageRefsResolve',
  description:
    'Gate: <img src> references in an HTML file point at files that actually exist in the workspace (catches assets linked from the wrong path).',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'HTML file to check.', default: 'index.html' },
    requireAll: {
      type: 'boolean',
      description: 'Require EVERY image ref to resolve (default: at least one).',
      default: false,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const file = input.file ?? 'index.html';
const ws = workspaceFromGezel(gezel);
const content = await ws.read(file);
if (content === null) {
  gezel.output(gateResult(false, `${file} not found — write the deliverable before advancing.`));
} else {
  const report = imageRefsResolve(content, file, await ws.list(), input.requireAll);
  gezel.output(
    gateResult(
      report.ok,
      report.ok
        ? report.detail
        : `${report.detail}. Generate the missing assets or fix the src paths so they resolve relative to ${file}.`,
    ),
  );
}
