import { describe, expect, it, vi } from 'vitest';
import { salvageImmediateFileWriteArgs } from './immediate-write-salvage.js';
import {
  LocalTurnPolicy,
  compactLocalTurn,
  planFileTurn,
  turnCheckpoint,
} from './local-turn-policy.js';

const tools = ['read_file', 'write_file', 'replace_in_file'].map((name) => ({
  type: 'function' as const,
  function: { name, description: '', parameters: {} },
}));

describe('file intent without harness wording', () => {
  it.each(['src/worker.py', 'notes/release.rst', 'assets/catalog.xml', 'workspace/index.html'])(
    'does not treat a mention of %s as an instruction to overwrite it',
    (path) => {
      expect(planFileTurn(`Explain what ${path} is for. Do not edit it.`, tools).kind).toBe(
        'ordinary',
      );
    },
  );
  it.each(['src/worker.py', 'notes/release.rst', 'views/dashboard.html'])(
    'recognizes ordinary creation and repair requests for %s',
    (path) => {
      expect(
        planFileTurn(`First step: create ${path} from scratch using write_file.`, tools).kind,
      ).toBe('create-file');
      expect(
        planFileTurn(
          `The acceptance checks for \`${path}\` failed. Please correct the existing file.`,
          tools,
        ).kind,
      ).toBe('repair-file');
      expect(
        planFileTurn(
          `Tests are still failing in \`${path}\`; investigate and fix the regression.`,
          tools,
        ).kind,
      ).toBe('repair-file');
    },
  );
  it('gives explicit intent precedence over text and never invents a mutation tool', () => {
    const intent = { kind: 'repair-file' as const, path: 'lib/decoder.rs' };
    expect(planFileTurn('Write the file now.', tools, intent).kind).toBe('repair-file');
    expect(planFileTurn('Write the file now.', [tools[0]!], intent).kind).toBe('ordinary');
  });
});

describe('filename-independent text salvage', () => {
  const html = '<!doctype html><html><body><script>console.log(1)</script></body></html>';
  it('requires an identifiable target instead of defaulting to a homepage', () => {
    expect(salvageImmediateFileWriteArgs(html, 'Finish the file.')).toBeNull();
    expect(salvageImmediateFileWriteArgs(html, 'Create views/mobile.html now.')).toEqual({
      path: 'views/mobile.html',
      content: html,
    });
    expect(salvageImmediateFileWriteArgs(html, 'Finish the file.', 'views/preview.html')).toEqual({
      path: 'views/preview.html',
      content: html,
    });
  });
});

describe('shared recovery budgets', () => {
  it('does not refresh a budget when the malformed call changes', () => {
    const policy = new LocalTurnPolicy();
    expect(policy.retry('malformed', 'one')).toBe(true);
    expect(policy.retry('malformed', 'two')).toBe(true);
    expect(policy.retry('malformed', 'three')).toBe(false);
  });
  it('stops a repeated malformed call and bounds rescue and continuation attempts', () => {
    const policy = new LocalTurnPolicy();
    expect(policy.retry('malformed', 'same')).toBe(true);
    expect(policy.retry('malformed', 'same')).toBe(false);
    expect(policy.requireProgressRetry()).toBe(1);
    expect(policy.requireProgressRetry()).toBe(2);
    expect(() => policy.requireProgressRetry()).toThrow('without a successful workspace mutation');
    for (let i = 0; i < 6; i++) expect(policy.retry('writeContinuations')).toBe(true);
    expect(policy.retry('writeContinuations')).toBe(false);
  });
  it('checks cancellation and the awake-time deadline before allowing rescue', () => {
    const ctrl = new AbortController();
    const expired = vi.fn(() => false);
    const policy = new LocalTurnPolicy(
      turnCheckpoint(ctrl.signal, expired, () => new Error('deadline')),
    );
    expect(policy.retry('noProgress')).toBe(true);
    expired.mockReturnValue(true);
    expect(() => policy.retry('noProgress')).toThrow('deadline');
    ctrl.abort();
    expect(() => policy.retry('noProgress')).toThrow(/cancelled|stopped/i);
  });
});

describe('shared compaction', () => {
  function adapter() {
    return {
      messages: [
        { role: 'system', content: 'stable' },
        { role: 'system', content: 'volatile' },
        { role: 'user', content: 'prior' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'active' },
        { role: 'tool', content: 'active result' },
      ],
      turnStart: 4,
      estimatedTokens: 800,
      numCtx: 1000,
      request: vi.fn(async () => ({ syntheticContent: 'summary' })),
      replace: vi.fn(),
      warn: vi.fn(),
      completed: vi.fn(),
    };
  }
  it('preserves system bands and active tool exchanges, spending one compaction', async () => {
    const a = adapter();
    const policy = new LocalTurnPolicy();
    expect(await compactLocalTurn(policy, a)).toBe(true);
    expect(a.request).toHaveBeenCalledWith({
      priorMessages: a.messages.slice(2, 4),
      estimatedTokens: 800,
      numCtx: 1000,
    });
    expect(a.replace).toHaveBeenCalledWith(2, 2, 'summary');
    expect(await compactLocalTurn(policy, a, true)).toBe(false);
    expect(a.request).toHaveBeenCalledTimes(1);
  });
  it('does not retry a failing compactor or replace history after cancellation', async () => {
    const a = adapter();
    const policy = new LocalTurnPolicy();
    a.request.mockRejectedValue(new Error('unavailable'));
    expect(await compactLocalTurn(policy, a)).toBe(false);
    expect(await compactLocalTurn(policy, a, true)).toBe(false);
    expect(a.request).toHaveBeenCalledTimes(1);
    const ctrl = new AbortController();
    a.request.mockImplementation(async () => {
      ctrl.abort();
      return { syntheticContent: 'late' };
    });
    const cancelled = new LocalTurnPolicy(
      turnCheckpoint(
        ctrl.signal,
        () => false,
        () => new Error('deadline'),
      ),
    );
    await expect(compactLocalTurn(cancelled, a)).rejects.toThrow(/cancelled|stopped/i);
    expect(a.replace).not.toHaveBeenCalled();
  });
});
