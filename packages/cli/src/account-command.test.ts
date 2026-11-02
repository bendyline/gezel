import type { Account } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { readNewPassword, registerAccountCommands } from './account-command.js';

function piped(text: string) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

const mike: Account = {
  id: 'a1',
  name: 'Mike',
  role: 'admin',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const lines: string[] = [];
  const client = {
    listAccounts: async () => ({ accounts: [mike] }),
    createAccount: async (name: string, password: string) => {
      calls.push(['create', name, password]);
      return { account: { ...mike, id: 'a2', name } };
    },
    setAccountPassword: async (id: string, password: string) => {
      calls.push(['password', id, password]);
      return { account: mike };
    },
    updateAccount: async (id: string, change: unknown) => {
      calls.push(['update', id, change]);
      return { account: mike };
    },
    removeAccount: async (id: string) => {
      calls.push(['remove', id]);
      return { removed: true };
    },
    listAccountSessions: async () => ({ sessions: [] }),
    signOutAccountEverywhere: async () => ({ signedOut: 2 }),
    createSetupLink: async () => ({ code: 'ABCDE', url: 'http://localhost:6228/?setup=ABCDE' }),
    ...overrides,
  };
  const program = new Command().exitOverride();
  registerAccountCommands(
    program,
    async () => client as never,
    (line) => lines.push(line),
    piped('hunter2-but-longer\n'),
  );
  const run = (...args: string[]) => program.parseAsync(['node', 'gezel', 'account', ...args]);
  return { run, calls, lines };
}

describe('readNewPassword', () => {
  it('reads piped stdin and drops the trailing newline', async () => {
    expect(await readNewPassword({ passwordStdin: true }, piped('secret pass\n'))).toBe(
      'secret pass',
    );
  });

  it('refuses when there is no terminal and no pipe was asked for', async () => {
    await expect(readNewPassword({}, piped('x'))).rejects.toThrow(/--password-stdin/);
  });
});

describe('gezel account', () => {
  it('creates an account with a piped password', async () => {
    const { run, calls, lines } = harness();
    await run('create', 'Ana', '--password-stdin');
    expect(calls).toEqual([['create', 'Ana', 'hunter2-but-longer']]);
    expect(lines).toEqual(['Ana can now sign in.']);
  });

  it('finds people by name in any case', async () => {
    const { run, calls } = harness();
    await run('reset-password', 'mike', '--password-stdin');
    await run('disable', 'MIKE');
    expect(calls).toEqual([
      ['password', 'a1', 'hunter2-but-longer'],
      ['update', 'a1', { disabled: true }],
    ]);
  });

  it('asks for --yes before removing anyone', async () => {
    const { run, calls } = harness();
    await expect(run('remove', 'Mike')).rejects.toThrow(/--yes/);
    await run('remove', 'Mike', '--yes');
    expect(calls).toEqual([['remove', 'a1']]);
  });

  it("passes on the daemon's plain refusal", async () => {
    const { run } = harness({
      removeAccount: async () => {
        throw new GezelApiError('Gezel API error 409', 409, {
          error: 'last_admin',
          message: 'At least one account that can manage accounts has to remain.',
        });
      },
    });
    await expect(run('remove', 'Mike', '--yes')).rejects.toThrow(/has to remain/);
  });

  it('prints the setup link', async () => {
    const { run, lines } = harness();
    await run('setup-link');
    expect(lines[0]).toContain('http://localhost:6228/?setup=ABCDE');
  });
});
