import { describe, expect, it, vi } from 'vitest';
import { gateResult, jsonValid, workspaceFromGezel } from './checks.js';

describe('gate script helpers', () => {
  it('creates stable approve and reject envelopes', () => {
    expect(gateResult(true, 'all good')).toEqual({ decision: 'approve', message: 'all good' });
    expect(gateResult(false, 'missing file')).toEqual({
      decision: 'reject',
      message: 'missing file',
    });
  });

  it('adapts gezel filesystem reads and listings', async () => {
    const read = vi.fn(async (path: string) => `content:${path}`);
    const listAll = vi.fn(async () => ['a.md', 'nested/b.md']);
    const workspace = workspaceFromGezel({ fs: { read, listAll } });

    await expect(workspace.read('a.md')).resolves.toBe('content:a.md');
    await expect(workspace.list()).resolves.toEqual(['a.md', 'nested/b.md']);
  });

  it('normalizes missing or unreadable files to null', async () => {
    const workspace = workspaceFromGezel({
      fs: {
        read: async () => {
          throw new Error('ENOENT');
        },
        listAll: async () => [],
      },
    });

    await expect(workspace.read('missing.md')).resolves.toBeNull();
  });

  it('re-exports the core predicates used by standard scripts', () => {
    expect(jsonValid('{"ok":true}')).toMatchObject({ ok: true });
    expect(jsonValid('{broken')).toMatchObject({ ok: false });
  });
});
