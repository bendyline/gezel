import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  detectUnclosedScript,
  extractInlineScripts,
  gateResult,
  validateScriptSyntax,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkJsParses',
  description:
    'Gate: every inline <script> in an HTML file parses as valid JavaScript (V8 parser), with truncation detection and an optional total-size floor.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'HTML file to check.', default: 'index.html' },
    minInlineJsBytes: {
      type: 'number',
      description: 'Minimum total inline JS bytes (0 = no size floor).',
      default: 0,
      integer: true,
      min: 0,
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
  const truncation = detectUnclosedScript(content);
  if (truncation.unclosed) {
    gezel.output(
      gateResult(
        false,
        `${file} has ${truncation.opens} <script> opener(s) but only ${truncation.closes} </script> closer(s) — the file was cut off mid-script. Rewrite it completely, ending every script block.`,
      ),
    );
  } else {
    const validation = validateScriptSyntax(extractInlineScripts(content));
    const minJs = input.minInlineJsBytes ?? 0;
    if (!validation.allParse) {
      gezel.output(
        gateResult(
          false,
          `${file} has inline JavaScript that does not parse: ${validation.firstError ?? 'syntax error'}. Fix the syntax error and re-advance.`,
        ),
      );
    } else if (minJs > 0 && validation.totalBytes < minJs) {
      gezel.output(
        gateResult(
          false,
          `${file} has only ${validation.totalBytes} bytes of inline JavaScript, need ≥ ${minJs} — the page logic looks like a stub.`,
        ),
      );
    } else {
      gezel.output(
        gateResult(true, `${file}: all inline JS parses (${validation.totalBytes} bytes)`),
      );
    }
  }
}
