import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  gateResult,
  htmlGameSniff,
  inlineJsBytes,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkHtmlGame',
  description:
    'Gate: an HTML file is plausibly a real browser game — a <canvas>/<svg> render surface, closed <script> tags, and non-trivial inline JavaScript.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'HTML file to check.', default: 'index.html' },
    minInlineJsBytes: {
      type: 'number',
      description: 'Minimum bytes of inline JavaScript.',
      default: 400,
      integer: true,
      min: 1,
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
const content = await workspaceFromGezel(gezel).read(file);
if (content === null) {
  gezel.output(gateResult(false, `${file} not found — write the deliverable before advancing.`));
} else {
  const minJs = input.minInlineJsBytes ?? 400;
  const ok = htmlGameSniff(content, minJs);
  const js = inlineJsBytes(content);
  gezel.output(
    gateResult(
      ok,
      ok
        ? `${file} has a render surface and ${js} bytes of inline JS`
        : `${file} is not yet a working game page: it needs a <canvas> or <svg> render surface, every <script> closed, and at least ${minJs} bytes of inline JavaScript (currently ${js}).`,
    ),
  );
}
