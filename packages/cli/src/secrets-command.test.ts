import { Readable } from 'node:stream';
import type { GezelClient } from '@bendyline/gezel-client';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { readSecretInput, registerSecretCommands } from './secrets-command.js';

describe('credential input', () => {
  it('reads environment values or piped UTF-8 without leaving a shell newline', async () => {
    expect(await readSecretInput({ env: 'TEST_KEY' }, { TEST_KEY: 'test-value' })).toBe(
      'test-value',
    );
    const bytes = Buffer.from('test-é\r\n');
    expect(
      await readSecretInput(
        { stdin: true },
        {},
        Readable.from([bytes.subarray(0, 6), bytes.subarray(6)]),
      ),
    ).toBe('test-é');
  });
  it('requires exactly one input source, nonempty single-line content, and bounded size', async () => {
    await expect(readSecretInput({})).rejects.toThrow('exactly one');
    await expect(readSecretInput({ stdin: true, env: 'TEST_KEY' })).rejects.toThrow('exactly one');
    await expect(readSecretInput({ env: 'MISSING' }, {})).rejects.toThrow('empty');
    await expect(readSecretInput({ env: '$NOT_A_NAME' }, {})).rejects.toThrow('variable name');
    for (const value of ['a\nb', 'a\0b', 'x'.repeat(65_537)]) {
      await expect(readSecretInput({ stdin: true }, {}, Readable.from([value]))).rejects.toThrow();
    }
  });
  it('does not read an echoing terminal', async () => {
    await expect(
      readSecretInput({ stdin: true }, {}, Object.assign(Readable.from([]), { isTTY: true })),
    ).rejects.toThrow('piped');
  });
});

describe('credential commands', () => {
  function fixture() {
    const client = {
      getConfig: vi.fn().mockResolvedValue({
        hasBraveSearchApiKey: true,
        braveSearchApiKey: 'must-never-be-printed',
        webSearch: { provider: 'wikipedia', defaultLimit: 7, deny: ['private.example'] },
      }),
      updateConfig: vi.fn().mockResolvedValue({}),
    };
    const connect = vi.fn().mockResolvedValue(client);
    const output = vi.fn();
    const run = async (...args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerSecretCommands(program, connect as () => Promise<GezelClient>, output);
      await program.parseAsync(['secret', ...args], { from: 'user' });
    };
    return { run, output, connect, client };
  }
  it('lists only known credential names and presence flags', async () => {
    const { run, output } = fixture();
    await run('list', '--json');
    expect(output.mock.calls[0]?.[0] ?? '').not.toContain('must-never-be-printed');
    expect(JSON.parse(output.mock.calls[0]?.[0] ?? '').credentials).toContainEqual({
      name: 'braveSearchApiKey',
      configured: true,
    });
  });
  it('stores a key and explicitly selects search without dropping its existing options', async () => {
    const { run, client, output } = fixture();
    vi.stubEnv('GEZEL_TEST_SECRET_INPUT', 'test-input-value');
    try {
      await run(
        'set',
        'braveSearchApiKey',
        '--env',
        'GEZEL_TEST_SECRET_INPUT',
        '--use-for-search',
        '--json',
      );
      expect(client.updateConfig).toHaveBeenCalledWith({
        braveSearchApiKey: 'test-input-value',
        webSearch: { provider: 'brave', defaultLimit: 7, deny: ['private.example'] },
      });
      expect(JSON.parse(output.mock.calls[0]?.[0] ?? '')).toEqual({
        name: 'braveSearchApiKey',
        configured: true,
        searchProvider: 'brave',
      });
      client.updateConfig.mockRejectedValue(new Error('server echoed test-input-value'));
      await expect(
        run('set', 'braveSearchApiKey', '--env', 'GEZEL_TEST_SECRET_INPUT'),
      ).rejects.toThrow(
        /^Could not update the credential\. Check the service connection and permissions\.$/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('clears through the write-only API and refuses arbitrary config keys before connecting', async () => {
    const { run, client, connect } = fixture();
    await expect(run('remove', 'deviceIdentity')).rejects.toThrow('Unknown credential');
    await expect(run('set', 'openaiApiKey', '--stdin', '--use-for-search')).rejects.toThrow(
      'requires braveSearchApiKey',
    );
    await expect(run('set', 'tavilyApiKey', '--stdin', '--use-for-search')).rejects.toThrow(
      'Tavily search is not available yet',
    );
    expect(connect).not.toHaveBeenCalled();
    await run('remove', 'openaiApiKey');
    expect(client.updateConfig).toHaveBeenCalledWith({ openaiApiKey: '' });
  });
});
