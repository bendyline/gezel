import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkWorkspaceScript',
  description:
    'Gate: run a caller-pinned Node.js/TypeScript checker from the workspace inside the existing no-network, no-child-process sandbox; exit 0 approves and any other result rejects with the checker output.',
  kind: 'gate',
  inputs: {
    script: {
      type: 'string',
      description: 'Workspace-relative path to the checker script.',
      required: true,
    },
    expectedSource: {
      type: 'string',
      description:
        'Optional exact checker source pinned by the caller. When supplied, a modified checker rejects before execution.',
    },
    timeoutMs: {
      type: 'number',
      description: 'Checker timeout in milliseconds (the runtime clamps it to 30s-30min).',
      default: 120000,
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete checker failure.' },
  },
  // `mcp.call` is capability-gated as network even though this script only
  // calls the local, sandboxed run_nodejs_script tool.
  requires: ['workspace.read', 'network'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const ws = workspaceFromGezel(gezel);
const source = await ws.read(input.script);

if (source === null) {
  gezel.output(
    gateResult(
      false,
      `Trusted checker ${input.script} is missing. Restore the caller-provided checker before completing the deliverable.`,
    ),
  );
} else if (input.expectedSource !== undefined && source !== input.expectedSource) {
  gezel.output(
    gateResult(
      false,
      `Trusted checker ${input.script} was modified. Restore the caller-pinned source; deliverable code must not alter its own acceptance checker.`,
    ),
  );
} else {
  const raw = await gezel.mcp.call('run_nodejs_script', {
    path: input.script,
    timeoutMs: input.timeoutMs ?? 120000,
  });
  const content =
    raw && typeof raw === 'object' && 'content' in raw && Array.isArray(raw.content)
      ? raw.content
          .map((part) =>
            part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
              ? part.text
              : '',
          )
          .filter(Boolean)
          .join('\n')
      : typeof raw === 'string'
        ? raw
        : JSON.stringify(raw);
  const ok = /completed \(exit 0\)/i.test(content);
  const bounded = content.trim().slice(0, 3500);
  gezel.output(
    gateResult(
      ok,
      ok
        ? `Trusted checker ${input.script} passed.`
        : `Trusted checker ${input.script} failed. Fix the reported deliverable mismatch, then complete the turn again.\n${bounded || 'The checker returned no readable output.'}`,
    ),
  );
}
