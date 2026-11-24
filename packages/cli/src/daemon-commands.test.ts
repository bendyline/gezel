/**
 * The built CLI's commands against a live `gezeld` child: each test proves a
 * command is wired into the real binary and that the daemon keeps what it
 * wrote. A command's own logic belongs in a unit test beside it (as in
 * settings-command.test.ts); launching the CLI costs about a second each.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  childEnv,
  cliEntry,
  client,
  daemonWorkspaceDirs,
  execFileAsync,
  gezelHome,
  registerSharedDaemon,
  runCli,
  runCliAtHome,
  workspaceCwd,
} from './test-support/shared-daemon.js';

registerSharedDaemon();

// Every case here crosses a process boundary, and the CLI-entry cases shell
// out with a 25s `execFile` budget each — more than vitest's 5s default.
describe('gezel commands against a live daemon', { timeout: 30_000 }, () => {
  it('sets, lists, and removes write-only provider credentials through the built CLI', async () => {
    const value = 'integration-only-credential-value';
    const saved = await execFileAsync(
      process.execPath,
      [
        cliEntry,
        '--home',
        gezelHome,
        'secret',
        'set',
        'braveSearchApiKey',
        '--env',
        'GEZEL_TEST_SECRET_INPUT',
        '--use-for-search',
        '--json',
      ],
      {
        env: childEnv({
          GEZEL_HOME: gezelHome,
          GEZEL_MOCK_PROVIDER: '1',
          GEZEL_TEST_SECRET_INPUT: value,
        }),
        timeout: 25_000,
      },
    );
    expect(JSON.parse(saved.stdout)).toEqual({
      name: 'braveSearchApiKey',
      configured: true,
      searchProvider: 'brave',
    });
    const config = await client.getConfig();
    expect(config.hasBraveSearchApiKey).toBe(true);
    expect(config.webSearch?.provider).toBe('brave');
    const listed = await runCli('secret', 'list', '--json');
    expect(JSON.parse(listed.stdout).credentials).toContainEqual({
      name: 'braveSearchApiKey',
      configured: true,
    });
    expect(saved.stdout + saved.stderr + listed.stdout + listed.stderr).not.toContain(value);
    const piped = execFileAsync(
      process.execPath,
      [cliEntry, '--home', gezelHome, 'secret', 'set', 'tavilyApiKey', '--stdin', '--json'],
      {
        env: childEnv({ GEZEL_HOME: gezelHome, GEZEL_MOCK_PROVIDER: '1' }),
        timeout: 25_000,
      },
    );
    piped.child.stdin?.end(`${value}\r\n`);
    expect(JSON.parse((await piped).stdout)).toEqual({ name: 'tavilyApiKey', configured: true });
    await runCli('secret', 'remove', 'braveSearchApiKey');
    await runCli('secret', 'remove', 'tavilyApiKey');
    expect((await client.getConfig()).hasBraveSearchApiKey).toBe(false);
    expect((await client.getConfig()).hasTavilyApiKey).toBe(false);
    await client.updateConfig({ webSearch: { provider: 'mock' } });
  });

  it('sets, reads, and clears a gezel output limit without erasing its other tuning', async () => {
    const gezel = await client.createGezel({ name: 'Output budget test', about: 'Test only.' });
    const tuning = {
      sampling: { temperature: 0.35, maxTokens: 8192 },
      reasoning: { thinkingBudget: 2048 },
    };
    await client.updateGezelSettings(gezel.id, { tuning });
    const args = ['agent', 'output-limit', gezel.id];
    expect(JSON.parse((await runCli(...args, '--json')).stdout)).toEqual({
      gezelId: gezel.id,
      outputTokens: 8192,
    });
    expect(JSON.parse((await runCli(...args, '16384', '--json')).stdout)).toEqual({
      gezelId: gezel.id,
      outputTokens: 16384,
    });
    expect((await client.getGezel(gezel.id)).parsed.frontmatter.tuning).toEqual({
      ...tuning,
      sampling: { ...tuning.sampling, maxTokens: 16384 },
    });
    expect(JSON.parse((await runCli(...args, 'auto', '--json')).stdout).outputTokens).toBeNull();
    expect((await client.getGezel(gezel.id)).parsed.frontmatter.tuning).toEqual({
      sampling: { temperature: 0.35 },
      reasoning: tuning.reasoning,
    });
    for (const value of ['0', '-1', '1.5', '1e4', '9007199254740992']) {
      await expect(runCli(...args, value)).rejects.toMatchObject({
        stderr: expect.stringContaining('positive integer'),
      });
    }
    const plain = await client.createGezel({
      name: 'Inherited output budget test',
      about: 'Test only.',
    });
    await runCli('agent', 'output-limit', plain.id, '1024');
    await runCli('agent', 'output-limit', plain.id, 'auto');
    expect((await client.getGezel(plain.id)).parsed.frontmatter.tuning).toBeUndefined();
  }, 30_000);

  it('sets, reads, and clears model context through the CLI without changing other models', async () => {
    await client.updateModelContextOverride('llama-cpp', 'unrelated-model', 98304);
    const args = ['model', 'context', 'test-model'];
    const set = JSON.parse(
      (await runCli(...args, '65536', '--provider', 'llama-cpp', '--json')).stdout,
    );
    expect(set).toEqual({ provider: 'llama-cpp', modelId: 'test-model', contextTokens: 65536 });
    expect(JSON.parse((await runCli(...args, '--provider', 'llama-cpp', '--json')).stdout)).toEqual(
      set,
    );
    await expect(runCli(...args, '1e5')).rejects.toMatchObject({ code: 1 });
    await expect(runCli(...args, '1024')).rejects.toMatchObject({ code: 1 });
    await runCli(...args, 'auto', '--provider', 'llama-cpp');
    expect((await client.getModelContextOverrides('llama-cpp')).overrides).toEqual({
      'unrelated-model': 98304,
    });
    await client.updateModelContextOverride('llama-cpp', 'unrelated-model', null);
  });

  it('pauses one task idempotently through the CLI while preserving other task work', async () => {
    const create = (title: string) =>
      client.createTask('default', {
        title,
        description: 'Manual task for the CLI pause integration check.',
        assignee: { kind: 'user' },
        steps: [{ name: 'Main' }],
      });
    const target = await create('Pause target');
    const neighbor = await create('Unaffected neighbor');
    const before = (await client.getConfig()).aiEngagementMode;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(JSON.parse((await runCli('task', 'pause', target.ref, '--json')).stdout)).toEqual({
        taskRef: target.ref,
        status: 'paused',
      });
    }
    expect((await client.getTaskByRef(neighbor.ref)).status).toBe('active');
    expect((await client.getConfig()).aiEngagementMode).toBe(before);
    await client.setTaskStatus(neighbor.projectId, neighbor.num, 'canceled');
    await expect(runCli('task', 'pause', neighbor.ref)).rejects.toMatchObject({
      stderr: expect.stringContaining('pause requires an active or paused task'),
    });
  });

  it('sets and clears inference concurrency while preserving other providers', async () => {
    const before = await client.getConfig();
    try {
      await client.updateConfig({
        providerConcurrency: { ...before.providerConcurrency, openai: 7 },
      });
      const args = ['model', 'concurrency'];
      expect(
        JSON.parse((await runCli(...args, '1', '--provider', 'llama-cpp', '--json')).stdout),
      ).toEqual({ provider: 'llama-cpp', slots: 1 });
      expect(
        JSON.parse((await runCli(...args, '--provider', 'llama-cpp', '--json')).stdout).slots,
      ).toBe(1);
      await expect(runCli(...args, '0')).rejects.toMatchObject({ code: 1 });
      await expect(runCli(...args, '1.5')).rejects.toMatchObject({ code: 1 });
      await runCli(...args, 'auto', '--provider', 'llama-cpp');
      expect(
        JSON.parse((await runCli(...args, '16', '--provider', 'codex-cli', '--json')).stdout),
      ).toEqual({ provider: 'codex-cli', slots: 16 });
      expect((await client.getConfig()).providerConcurrency?.['codex-cli']).toBe(16);
      await runCli(...args, 'auto', '--provider', 'codex-cli');
      await expect(runCli(...args, '2', '--provider', 'gemini')).rejects.toMatchObject({ code: 1 });
      expect((await client.getConfig()).providerConcurrency).toEqual({
        ...before.providerConcurrency,
        openai: 7,
      });
    } finally {
      await client.updateConfig({ providerConcurrency: before.providerConcurrency ?? {} });
    }
  });

  it.each([
    ['agent', 'list'],
    ['env', 'list'],
    ['task', 'list'],
    ['model', 'list'],
    ['native', 'list'],
    ['native', 'status'],
  ])('executes the %s command family in a subprocess', async (family, command) => {
    const result = await runCli(family, command);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('starts a craftbook from the do subcommand', async () => {
    const result = await runCli('do', 'security-architecture-review');
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^started .+\/\d+ — Security Architecture Review/m);

    const { projects } = await client.listProjects();
    const project = projects.find(
      (candidate) => candidate.workingDir?.toLowerCase() === workspaceCwd.toLowerCase(),
    );
    expect(project).toBeDefined();
    const { tasks } = await client.listProjectTasks(project!.id);
    expect(tasks.some((task) => task.craftbook.id === 'security-architecture-review')).toBe(true);
  });

  it('adds, lists, toggles, and removes an AI App through the app subcommand', async () => {
    // Build the fixture .gezapp through the daemon's own exporter — the
    // export route writes it into the default project's artifacts drawer,
    // and this test owns that home directory.
    const exported = await client.exportAiApp('default', { typeId: 'just-chat' });
    const fixturePath = join(gezelHome, 'projects', 'default', 'artifacts', exported.artifactPath);

    const added = await runCli('app', 'add', fixturePath, '--yes');
    expect(added.stderr).toBe('');
    expect(added.stdout).toContain('Installed just-chat@');

    const again = await runCli('app', 'add', fixturePath, '--yes');
    expect(again.stdout).toContain('already installed — no changes');

    const list = await runCli('app', 'list');
    expect(list.stdout).toContain('just-chat');
    expect(list.stdout).toContain('enabled');

    const folder = await mkdtemp(join(tmpdir(), 'gezel-app-apply-'));
    try {
      const applied = await runCliAtHome(
        gezelHome,
        '--project',
        folder,
        'app',
        'apply',
        'just-chat',
        '--yes',
      );
      expect(applied.stdout).toContain('Applied just-chat@');

      const status = await runCliAtHome(gezelHome, '--project', folder, 'app', 'status');
      expect(status.stdout).toContain('just-chat');
      expect(status.stdout).not.toContain('Update available');

      const noop = await runCliAtHome(
        gezelHome,
        '--project',
        folder,
        'app',
        'apply',
        'just-chat',
        '--yes',
      );
      expect(noop.stdout).toContain('already applied');
    } finally {
      daemonWorkspaceDirs.push(folder);
    }

    const disabled = await runCli('app', 'disable', 'just-chat');
    expect(disabled.stdout).toContain('Disabled just-chat@');

    const show = await runCli('app', 'show', 'just-chat');
    expect(show.stdout).toContain('state: disabled');

    const removed = await runCli('app', 'remove', 'just-chat', '--yes');
    expect(removed.stdout).toContain('Uninstalled just-chat');

    const empty = await runCli('app', 'list');
    expect(empty.stdout).toContain('No AI Apps installed');
  }, 90_000);
});
