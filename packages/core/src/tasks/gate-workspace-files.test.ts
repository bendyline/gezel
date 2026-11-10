import { describe, expect, it } from 'vitest';
import { stepWorkspaceDeliverableFiles } from './gate-workspace-files.js';

describe('stepWorkspaceDeliverableFiles', () => {
  it('names the advance file and every gated file that lands in the project folder', () => {
    expect(
      stepWorkspaceDeliverableFiles({
        advanceWhen: { file: 'index.html' },
        gate: {
          at: 'completion',
          checks: [
            { kind: 'minBytes', file: 'index.html', bytes: 200 },
            { kind: 'minBytes', file: 'sw.js', bytes: 50 },
          ],
        },
      } as never),
    ).toEqual(['index.html', 'sw.js']);
  });

  it('leaves out the artifacts drawer, which stays writable in a read-only folder', () => {
    expect(
      stepWorkspaceDeliverableFiles({
        advanceWhen: { file: 'tasks/3/scope.md', artifact: true },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'tasks/3/scope.md', bytes: 120, artifact: true }],
        },
      } as never),
    ).toEqual([]);
  });

  it('answers nothing for a step with no file to leave', () => {
    expect(stepWorkspaceDeliverableFiles({})).toEqual([]);
    expect(stepWorkspaceDeliverableFiles({ advanceWhen: null, gate: null })).toEqual([]);
  });
});
