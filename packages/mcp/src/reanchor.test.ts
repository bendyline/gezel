import { describe, expect, it } from 'vitest';
import { loadBuiltinToolContractsForLint } from './lint-contracts.js';
import {
  REANCHOR_MAX_CHARS,
  editReanchorDisabled,
  reanchorAfterEdit,
  withLineNumbers,
} from './reanchor.js';

const FILE = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'].join('\n');

function readFile(content = FILE) {
  return async () => content;
}

describe('withLineNumbers', () => {
  it('numbers from 1 by default', () => {
    expect(withLineNumbers('a\nb')).toBe('1→a\n2→b');
  });

  it('numbers a mid-file window from its real starting line', () => {
    expect(withLineNumbers('charlie\ndelta', 3)).toBe('3→charlie\n4→delta');
  });

  it('pads consistently when the window crosses a digit boundary', () => {
    expect(withLineNumbers('i\nj', 9)).toBe(' 9→i\n10→j');
  });

  it('preserves a trailing newline without numbering a phantom line', () => {
    expect(withLineNumbers('a\n')).toBe('1→a\n');
  });
});

describe('reanchorAfterEdit', () => {
  it('states the downward shift and re-prints the region with fresh numbers', async () => {
    // Two lines became five: everything below moved by +3.
    const out = await reanchorAfterEdit({
      path: 'src/server.mjs',
      startLine: 3,
      addedLines: 5,
      removedLines: 2,
      readFile: readFile(),
      env: {},
    });

    expect(out).toContain('Every line after 3 shifted by +3');
    expect(out).toContain('stale');
    expect(out).toContain('src/server.mjs now reads:');
    expect(out).toContain('3→charlie');
  });

  it('reports a negative shift when the edit removed lines', async () => {
    const out = await reanchorAfterEdit({
      path: 'a.ts',
      startLine: 2,
      addedLines: 1,
      removedLines: 4,
      readFile: readFile(),
      env: {},
    });

    expect(out).toContain('shifted by -3');
  });

  it('says line numbers are unchanged on an equal-size replacement', async () => {
    const out = await reanchorAfterEdit({
      path: 'a.ts',
      startLine: 2,
      addedLines: 2,
      removedLines: 2,
      readFile: readFile(),
      env: {},
    });

    expect(out).toContain('Line numbers elsewhere in the file are unchanged.');
    expect(out).not.toContain('shifted by');
  });

  it('caps the window so a huge replacement cannot flood the turn', async () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join(
      '\n',
    );
    const out = await reanchorAfterEdit({
      path: 'big.ts',
      startLine: 1,
      addedLines: 500,
      removedLines: 1,
      readFile: readFile(huge),
      env: {},
    });

    expect(out).toContain('window truncated');
    expect(out.length).toBeLessThan(REANCHOR_MAX_CHARS + 300);
  });

  it('returns nothing when the kill switch is set (the A/B control arm)', async () => {
    expect(
      await reanchorAfterEdit({
        path: 'a.ts',
        startLine: 1,
        addedLines: 2,
        removedLines: 1,
        readFile: readFile(),
        env: { GEZEL_DISABLE_EDIT_REANCHOR: '1' },
      }),
    ).toBe('');
  });

  it('never fails the edit when the re-read throws', async () => {
    expect(
      await reanchorAfterEdit({
        path: 'gone.ts',
        startLine: 1,
        addedLines: 1,
        removedLines: 1,
        readFile: async () => {
          throw new Error('ENOENT');
        },
        env: {},
      }),
    ).toBe('');
  });
});

describe('editReanchorDisabled', () => {
  it('accepts the repo kill-switch spellings', () => {
    expect(editReanchorDisabled({ GEZEL_DISABLE_EDIT_REANCHOR: '1' })).toBe(true);
    expect(editReanchorDisabled({ GEZEL_DISABLE_EDIT_REANCHOR: 'true' })).toBe(true);
    expect(editReanchorDisabled({ GEZEL_DISABLE_EDIT_REANCHOR: '0' })).toBe(false);
    expect(editReanchorDisabled({})).toBe(false);
  });
});

describe('replace_lines tool contract', () => {
  it('warns in the description that line numbers shift after an edit', async () => {
    const contracts = await loadBuiltinToolContractsForLint();
    const replaceLines = contracts.find((tool) => tool.name === 'replace_lines');

    expect(replaceLines).toBeDefined();
    expect(replaceLines?.description).toMatch(/shifts the lines below it/i);
    expect(replaceLines?.description).toMatch(/stale/i);
  }, 30_000);
});
