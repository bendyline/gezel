import { describe, expect, it, vi } from 'vitest';
import {
  assertKnownFlags,
  parseArgs,
  resolveGeneralistFlag,
  resolveRepairPolicyFlag,
} from './args.ts';

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

describe('parseArgs', () => {
  it('treats a bare -- as a separator, not a flag', () => {
    // pnpm inserts `--` when forwarding through a wrapper script; parsing
    // it as a flag named "" made strict validation reject every leased
    // `pnpm eval:all` invocation with "Unknown flag --".
    const args = parseArgs(['--', '--suite', 'smoke', '--count', '1']);
    expect(args.flags).toEqual({ suite: 'smoke', count: '1' });
    expect(Object.keys(args.flags)).not.toContain('');
  });
});

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

describe('resolveGeneralistFlag', () => {
  it('returns undefined when the flag is absent (daemon default applies)', () => {
    const { exited } = capture(() => {
      expect(resolveGeneralistFlag(parseArgs(['--model', 'x']).flags)).toBeUndefined();
    });
    expect(exited).toBeNull();
  });

  it.each(['auto', 'on', 'off'] as const)('accepts --generalist %s', (value) => {
    let resolved: string | undefined;
    const { exited } = capture(() => {
      resolved = resolveGeneralistFlag(parseArgs(['--generalist', value]).flags);
    });
    expect(exited).toBeNull();
    expect(resolved).toBe(value);
  });

  it('rejects a typo instead of silently running the default arm', () => {
    const { errors, exited } = capture(() => {
      resolveGeneralistFlag(parseArgs(['--generalist', 'flat']).flags);
    });
    expect(exited).toBe(2);
    expect(errors.join('\n')).toContain('Unknown --generalist "flat"');
  });

  it('rejects a bare --generalist with no value', () => {
    const { errors, exited } = capture(() => {
      resolveGeneralistFlag(parseArgs(['--generalist']).flags);
    });
    expect(exited).toBe(2);
    expect(errors.join('\n')).toContain('needs a value');
  });

  it('names the replacement when the pre-v2 --render-mode spelling is used', () => {
    const { errors, exited } = capture(() => {
      resolveGeneralistFlag(parseArgs(['--render-mode', 'flat']).flags);
    });
    expect(exited).toBe(2);
    expect(errors.join('\n')).toContain('--render-mode was renamed to --generalist');
  });
});

describe('resolveRepairPolicyFlag', () => {
  it('returns undefined when the flag is absent (the scenario keeps its own policy)', () => {
    const { exited } = capture(() => {
      expect(resolveRepairPolicyFlag(parseArgs(['--model', 'x']).flags)).toBeUndefined();
    });
    expect(exited).toBeNull();
  });

  it.each(['harness', 'runtime'] as const)('accepts --repair-policy %s', (value) => {
    let resolved: string | undefined;
    const { exited } = capture(() => {
      resolved = resolveRepairPolicyFlag(parseArgs(['--repair-policy', value]).flags);
    });
    expect(exited).toBeNull();
    expect(resolved).toBe(value);
  });

  it('rejects an unknown policy instead of silently running the default', () => {
    const { errors, exited } = capture(() => {
      resolveRepairPolicyFlag(parseArgs(['--repair-policy', 'none']).flags);
    });
    expect(exited).toBe(2);
    expect(errors.join('\n')).toContain('Unknown --repair-policy "none"');
  });
});
