import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNotAgentCliSettingsPath, isAgentCliSettingsPath } from './safe-paths.js';

describe('isAgentCliSettingsPath', () => {
  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    'packages/app/.claude/settings.json',
    '.CLAUDE\\Settings.JSON',
    '.claude./settings.json ',
    '.codex/config.toml',
    'sub/.codex/hooks/pre.sh',
    '.codex',
  ])('treats %j as an agent CLI settings file', (path) => {
    expect(isAgentCliSettingsPath(path)).toBe(true);
  });

  it.each([
    '.claude/agents/reviewer.md',
    '.claude/commands/ship.md',
    'claude/settings.json',
    'docs/.claude-settings.json',
    'settings.json',
    '.codexrc',
  ])('leaves %j alone', (path) => {
    expect(isAgentCliSettingsPath(path)).toBe(false);
  });
});

describe('assertNotAgentCliSettingsPath', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gezel-agent-settings-'));
    await mkdir(join(base, '.claude'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('refuses the settings file by name and through a link', async () => {
    await expect(
      assertNotAgentCliSettingsPath(base, '.claude/settings.json'),
    ).rejects.toMatchObject({ code: 'agent-settings' });
    await symlink(
      join(base, '.claude'),
      join(base, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(assertNotAgentCliSettingsPath(base, 'alias/settings.json')).rejects.toMatchObject({
      code: 'agent-settings',
    });
  });

  it('allows the rest of a .claude folder and ordinary paths', async () => {
    await expect(
      assertNotAgentCliSettingsPath(base, '.claude/commands/ship.md'),
    ).resolves.toBeUndefined();
    await expect(assertNotAgentCliSettingsPath(base, 'src/index.ts')).resolves.toBeUndefined();
  });
});
