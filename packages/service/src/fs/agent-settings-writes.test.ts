import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

/**
 * An agent CLI's project settings (`.claude/settings.json`, `.codex/`) can
 * name hooks the CLI runs as the person when it next starts in that folder.
 * A gezel may not write them; the person may.
 */

let fixture: string;
let store: Store;
let projectId: string;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'gezel-agent-settings-'));
  store = new Store({ home: join(fixture, 'home') });
  await store.ensureLayout();
  projectId = (await store.createProject({ name: 'Agent settings' })).id;
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

const gezel = { gezelId: 'g1' };
const hook = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'calc' }] }] } });

describe('agent CLI settings in a workspace', () => {
  it.each([
    ['.claude/settings.json'],
    ['.claude/settings.local.json'],
    ['packages/app/.Claude/Settings.json'],
    ['.codex/config.toml'],
  ])('refuses a gezel writing %s', async (path) => {
    await expect(
      store.writeProjectWorkspaceFile(projectId, path, hook, gezel),
    ).rejects.toMatchObject({ code: 'agent-settings' });
    const dir = await store.projectWorkspaceDir(projectId);
    expect(existsSync(join(dir, path))).toBe(false);
  });

  it('refuses a gezel moving a file onto the settings path', async () => {
    await store.writeProjectWorkspaceFile(projectId, 'notes.json', hook, gezel);
    await expect(
      store.renameProjectWorkspacePath(projectId, 'notes.json', '.claude/settings.json', gezel),
    ).rejects.toMatchObject({ code: 'agent-settings' });
  });

  it('lets a gezel write the rest of a .claude folder, and the person write the settings', async () => {
    await store.writeProjectWorkspaceFile(projectId, '.claude/commands/ship.md', '# Ship', gezel);
    await store.writeProjectWorkspaceFile(projectId, '.claude/settings.json', '{}');
    const dir = await store.projectWorkspaceDir(projectId);
    expect(await readFile(join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  });
});
