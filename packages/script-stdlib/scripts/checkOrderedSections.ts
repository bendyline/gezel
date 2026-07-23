import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import {
  gateResult,
  requireOrderedSections,
  workspaceFromGezel,
} from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkOrderedSections',
  description:
    'Gate: a Markdown file contains the given section headers IN ORDER (any # depth) — e.g. the canonical postmortem sections.',
  kind: 'gate',
  inputs: {
    file: { type: 'string', description: 'Markdown file to check.', required: true },
    sections: {
      type: 'json',
      description: 'Ordered array of header titles, e.g. ["Summary", "Impact", "Timeline"].',
      required: true,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const sections = Array.isArray(input.sections) ? input.sections.map(String) : [];
const content = await workspaceFromGezel(gezel).read(input.file);
if (content === null) {
  gezel.output(
    gateResult(false, `${input.file} not found — write the deliverable before advancing.`),
  );
} else if (sections.length === 0) {
  gezel.output(gateResult(false, 'No sections configured — set the "sections" input.'));
} else {
  const r = requireOrderedSections(content, sections);
  gezel.output(
    gateResult(
      r.ok,
      r.ok
        ? `${input.file} has all ${sections.length} sections in order`
        : `${input.file} is missing the "${r.ok === false ? r.missing : ''}" section (or it appears out of order). Required order: ${sections.join(' → ')}.`,
    ),
  );
}
