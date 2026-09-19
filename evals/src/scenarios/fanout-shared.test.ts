import { describe, expect, it } from 'vitest';
import { isWorkspaceWriteReceipt, toolReceiptsObservable } from './fanout-shared.ts';

describe('toolReceiptsObservable', () => {
  it('is false when the project history holds no tool events at all', () => {
    expect(toolReceiptsObservable([])).toBe(false);
    expect(toolReceiptsObservable([{ entryType: 'session', details: {} }])).toBe(false);
  });

  it('is true as soon as any tool call was recorded', () => {
    expect(
      toolReceiptsObservable([
        { entryType: 'event', details: { name: 'read_file', success: true, taskRef: 'p/2' } },
      ]),
    ).toBe(true);
  });
});

describe('isWorkspaceWriteReceipt', () => {
  it('accepts the gezel-mcp writers and the Claude CLI file tools alike', () => {
    for (const name of [
      'write_file',
      'replace_in_file',
      'apply_patch',
      'Write',
      'Edit',
      'MultiEdit',
    ]) {
      expect(isWorkspaceWriteReceipt(name)).toBe(true);
    }
  });

  it('rejects reads, searches and non-string names', () => {
    for (const name of [
      'read_file',
      'Read',
      'Glob',
      'ToolSearch',
      'write_artifact',
      undefined,
      7,
    ]) {
      expect(isWorkspaceWriteReceipt(name)).toBe(false);
    }
  });
});
