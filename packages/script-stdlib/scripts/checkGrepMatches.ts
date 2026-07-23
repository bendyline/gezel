import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, grepMatches, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkGrepMatches',
  description:
    'Gate: grepping the workspace for a pattern returns results — at least minMatches files contain it (optionally scoped by directory/extensions).',
  kind: 'gate',
  inputs: {
    pattern: { type: 'string', description: 'Regular expression to search for.', required: true },
    dir: { type: 'string', description: 'Restrict to this directory (optional).' },
    extensions: {
      type: 'string',
      description: 'Comma-separated extensions to scan, e.g. "ts,js" (optional).',
    },
    flags: { type: 'string', description: 'Regex flags, e.g. "i".', default: 'i' },
    minMatches: {
      type: 'number',
      description: 'Minimum number of files that must match.',
      default: 1,
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
const r = await grepMatches(workspaceFromGezel(gezel), input.pattern, {
  ...(input.dir ? { dir: input.dir } : {}),
  ...(input.extensions
    ? {
        ext: input.extensions
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean),
      }
    : {}),
  ...(input.flags ? { flags: input.flags } : {}),
  minMatches: input.minMatches,
});
gezel.output(gateResult(r.ok, r.detail));
