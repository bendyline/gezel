import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, htmlCompleteSniff, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkHtmlComplete',
  description:
    'Gate: an HTML file is not truncated — every <script> tag closes and the document has a closing </body> or </html>.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'HTML file to check.', default: 'index.html' },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const file = input.file ?? 'index.html';
const content = await workspaceFromGezel(gezel).read(file);
if (content === null) {
  gezel.output(gateResult(false, `${file} not found — write the deliverable before advancing.`));
} else {
  const ok = htmlCompleteSniff(content);
  gezel.output(
    gateResult(
      ok,
      ok
        ? `${file} is a complete HTML document`
        : `${file} looks truncated: make sure every <script> has a matching </script> and the document ends with </body></html>.`,
    ),
  );
}
