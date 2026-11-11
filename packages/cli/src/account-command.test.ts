import type { Account } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  describeAppAddresses,
  keyedAddress,
  readNewPassword,
  registerAccountCommands,
  registerIntegrationCommands,
} from './account-command.js';

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
    createSetupLink: async () => ({ code: 'ABCDE', url: 'http://localhost:6230/?setup=ABCDE' }),
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
    expect(lines[0]).toContain('http://localhost:6230/?setup=ABCDE');
  });
});

function integrations(
  options: {
    config?: Record<string, unknown>;
    baseUrl?: string;
    env?: NodeJS.ProcessEnv;
    answering?: boolean;
    updateConfig?: (patch: unknown) => Promise<unknown>;
  } = {},
) {
  const lines: string[] = [];
  const patches: unknown[] = [];
  let config = options.config ?? {};
  const client = {
    getBaseUrl: () => options.baseUrl ?? 'https://127.0.0.1:6228',
    getConfig: async () => config,
    updateConfig:
      options.updateConfig ??
      (async (patch: { openaiEndpoints?: Record<string, unknown> }) => {
        patches.push(patch);
        config = { ...config, ...patch };
        return config;
      }),
    createAppToken: async (appId: string) => ({ appId, scopes: ['openai'], token: 'k-secret' }),
  };
  const program = new Command().exitOverride();
  registerIntegrationCommands(
    program,
    async () => client as never,
    (line) => lines.push(line),
    { env: options.env ?? {}, ollamaAnswering: async () => options.answering ?? true },
  );
  const run = (...args: string[]) => program.parseAsync(['node', 'gezel', 'integrations', ...args]);
  return { run, lines, patches };
}

describe('where other programs reach Gezel', () => {
  it('gives a container the address it publishes, never its own loopback', () => {
    const inside = { getBaseUrl: () => 'http://127.0.0.1:16228' };
    expect(keyedAddress(inside, { GEZEL_CONTAINER: '1' })).toEqual({
      baseUrl: 'http://localhost:6230/v1',
      ownCertificate: false,
      container: true,
    });
    expect(
      keyedAddress(inside, { GEZEL_CONTAINER: '1', GEZEL_PUBLIC_URL: 'http://box.lan:6300/' })
        .baseUrl,
    ).toBe('http://box.lan:6300/v1');
  });

  it('names the plain-HTTP switch while it is off, and the addresses once it is on', () => {
    const keyed = keyedAddress({ getBaseUrl: () => 'https://127.0.0.1:6228' }, {});
    const off = describeAppAddresses({
      keyed,
      appsAllowed: true,
      emulation: { on: false, answering: null },
    }).join('\n');
    expect(off).toContain('https://127.0.0.1:6228/v1');
    expect(off).toContain("Gezel's own certificate");
    expect(off).toContain('"gezel integrations ollama on" turns it on');
    const on = describeAppAddresses({
      keyed,
      appsAllowed: true,
      emulation: { on: true, answering: true },
    }).join('\n');
    expect(on).toContain('http://127.0.0.1:11434/v1   OpenAI-style');
    expect(on).toContain('http://127.0.0.1:11434      Ollama');
  });

  it('says so when the switch is on but another program holds the port', () => {
    const text = describeAppAddresses({
      keyed: keyedAddress({ getBaseUrl: () => 'https://127.0.0.1:6228' }, {}),
      appsAllowed: true,
      emulation: { on: true, answering: false },
    }).join('\n');
    expect(text).toContain('not answering on port 11434');
    expect(text).not.toContain('OpenAI-style');
  });

  it('prints the base URL with a new key', async () => {
    const { run, lines } = integrations({ baseUrl: 'https://127.0.0.1:49152' });
    await run('token', 'create', 'my-app');
    expect(lines[0]).toContain('k-secret');
    expect(lines[0]).toContain('  https://127.0.0.1:49152/v1');
    expect(lines[0]).toContain('gezel integrations address');
  });
});

describe('gezel integrations ollama', () => {
  it('turns the plain-HTTP port on without dropping the other switches', async () => {
    const { run, lines, patches } = integrations({
      config: { openaiEndpoints: { servingGezelId: 'ambrose', supportingBehaviors: false } },
    });
    await run('ollama', 'on');
    expect(patches).toEqual([
      {
        openaiEndpoints: {
          servingGezelId: 'ambrose',
          supportingBehaviors: false,
          emulateOllama: true,
        },
      },
    ]);
    expect(lines[0]).toContain('Ollama emulation: on');
    expect(lines[0]).toContain('http://127.0.0.1:11434/v1');
    expect(lines[0]).toContain('without a key');
  });

  it('turns it off by leaving the switch out', async () => {
    const { run, lines, patches } = integrations({
      config: { openaiEndpoints: { servingGezelId: 'ambrose', emulateOllama: true } },
    });
    await run('ollama', 'off');
    expect(patches).toEqual([{ openaiEndpoints: { servingGezelId: 'ambrose' } }]);
    expect(lines[0]).toBe('Ollama emulation: off');
  });

  it('shows the setting without changing it', async () => {
    const { run, lines, patches } = integrations();
    await run('ollama');
    expect(patches).toEqual([]);
    expect(lines[0]).toBe('Ollama emulation: off');
  });

  it("passes on the service's reason when the port is taken", async () => {
    const { run } = integrations({
      updateConfig: async () => {
        throw new GezelApiError('Gezel API error 409', 409, {
          error: 'ollama-emulation-failed',
          message: 'Port 11434 is already in use — Ollama itself appears to be running there.',
        });
      },
    });
    await expect(run('ollama', 'on')).rejects.toThrow(/Ollama itself appears to be running/);
  });

  it('says so when this build does not offer the port', async () => {
    const { run } = integrations({ updateConfig: async () => ({ openaiEndpoints: {} }) });
    await expect(run('ollama', 'on')).rejects.toThrow(/does not offer/);
  });
});
