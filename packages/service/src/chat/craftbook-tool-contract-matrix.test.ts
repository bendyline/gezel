import { describe, expect, it } from 'vitest';
import { policyDeniedInstructedTools } from './craftbook-tool-contract-matrix.js';

describe('policyDeniedInstructedTools', () => {
  it('reports a tool the procedure uses that its own group denial removes', () => {
    expect(
      policyDeniedInstructedTools({
        prompt: 'Confirm each date with `web_search` before writing the timeline.',
        toolPolicy: { outputMedium: 'workspace', disallowBuiltinToolsets: ['web', 'images'] },
      }),
    ).toEqual([{ tool: 'web_search', cause: 'disallowBuiltinToolsets web' }]);
  });

  it('names the output contract when that is what removes the tool', () => {
    expect(
      policyDeniedInstructedTools({
        prompt: 'Save the working notes with `write_artifact`.',
        toolPolicy: { outputMedium: 'workspace' },
      }),
    ).toEqual([{ tool: 'write_artifact', cause: 'outputMedium workspace' }]);
  });

  it('does not report artifact reads, which survive a group-level artifacts denial', () => {
    expect(
      policyDeniedInstructedTools({
        prompt:
          'Read `tasks/20/outline.md` from the artifacts drawer with `read_artifact` and the approved `powerpoint/task-20/deck.md` from the workspace with `read_file`.',
        toolPolicy: { outputMedium: 'workspace', disallowBuiltinToolsets: ['artifacts'] },
      }),
    ).toEqual([]);
  });

  it('reports an artifact read the policy denies by exact name', () => {
    expect(
      policyDeniedInstructedTools({
        prompt: 'Read the scope with `read_artifact`.',
        toolPolicy: {
          outputMedium: 'workspace',
          disallowBuiltinToolsets: ['artifacts'],
          disallowTools: ['read_artifact'],
        },
      }),
    ).toEqual([{ tool: 'read_artifact', cause: 'disallowTools' }]);
  });

  // freeze-scope's frozen step lists the tools its boundary blocks. Naming a
  // tool the policy removes is only a contradiction when the procedure asks
  // for it.
  it('ignores descriptive, negated, and conditional mentions', () => {
    expect(
      policyDeniedInstructedTools({
        prompt: [
          'Opaque execution tools (`npm_install`, `derive_file`, and project-type application) are blocked because their write targets cannot be proven.',
          'Do not call `web_search`. If `wikipedia_search` is available, you may confirm names.',
        ].join('\n'),
        toolPolicy: {
          outputMedium: 'none',
          disallowBuiltinToolsets: ['web', 'workspace-fs-write', 'code-execution'],
        },
      }),
    ).toEqual([]);
  });
});
