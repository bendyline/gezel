import { describe, expect, it, vi } from 'vitest';
import { assertKnownFlags, parseArgs } from './args.ts';

function capture(run: () => void): { errors: string[]; exited: number | null } {
  const errors: string[] = [];
  let exited: number | null = null;
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts) => {
    errors.push(parts.join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code ?? 0;
    throw new Error('__exit__');
  }) as never);
  try {
    run();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__exit__') throw err;
  } finally {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { errors, exited };
}

describe('assertKnownFlags', () => {
  it("accepts a bin's own flags and the shared resolver flags", () => {
    const { exited } = capture(() => {
      assertKnownFlags(
        parseArgs(['--model', 'gemma4-26b-q4', '--provider', 'llama-cpp', '--count', '3']).flags,
        ['model', 'count'],
      );
    });
    expect(exited).toBeNull();
  });

  it('rejects an unknown flag and suggests the near miss', () => {
    // The bug this exists for: `eval:all --models a,b,c` (the flag is
    // singular) was dropped silently, so fifty minutes of GPU measured the
    // DEFAULT model and produced a clean-looking 0/3 that was
    // indistinguishable from the experiment actually asked for.
    const { errors, exited } = capture(() => {
      assertKnownFlags(parseArgs(['--models', 'a,b,c']).flags, ['model', 'count']);
    });
    expect(exited).toBe(2);
    expect(errors.join('\n')).toContain('Unknown flag --models');
    expect(errors.join('\n')).toContain('did you mean --model?');
  });

  it('lists the known flags so the fix does not need a source dive', () => {
    const { errors } = capture(() => {
      assertKnownFlags(parseArgs(['--sweet', 'x']).flags, ['suite']);
    });
    expect(errors.join('\n')).toContain('Known flags:');
    expect(errors.join('\n')).toContain('--suite');
  });

  it('reports every unknown flag, not just the first', () => {
    const { errors } = capture(() => {
      assertKnownFlags(parseArgs(['--nope', '1', '--alsonope', '2']).flags, ['model']);
    });
    expect(errors.join('\n')).toContain('--nope');
    expect(errors.join('\n')).toContain('--alsonope');
  });
});
