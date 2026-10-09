import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  type WorkspaceLike,
  containsPattern,
  gateResult,
  notContainsPattern,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkContains',
  description:
    'Gate: a workspace or artifacts file matches a regular expression — e.g. a "Game Over" marker, a required token, a section header — or, with absent, does not.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'File to check, relative to its tree.', required: true },
    pattern: { type: 'string', description: 'Regular expression to look for.', required: true },
    flags: { type: 'string', description: 'Regex flags, e.g. "i".', default: 'i' },
    label: {
      type: 'string',
      description: 'What the match stands for, named in the verdict (e.g. "a Risks section").',
    },
    artifact: {
      type: 'boolean',
      description: 'Read the file from the artifacts drawer instead of the workspace.',
      default: false,
    },
    absent: {
      type: 'boolean',
      description: 'Pass only when nothing matches: the pattern is forbidden content.',
      default: false,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read', 'artifacts.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const files: WorkspaceLike = input.artifact
  ? { read: (file) => gezel.artifacts.read(file).catch(() => null), list: async () => [] }
  : workspaceFromGezel(gezel);
const check = input.absent ? notContainsPattern : containsPattern;
const r = await check(files, input.file, input.pattern, input.flags, input.label);
gezel.output(gateResult(r.ok, r.detail));
