import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectGezelId, nowIso, projectGezelId } from '@bendyline/gezel';
import { gezelPoppetjePath } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lv-projlocal-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Create an internal-workspace project and seed an instruction file at its root. */
async function projectWithInstructionFile(
  name: string,
  file: string,
  content: string,
): Promise<{ projectId: string; ws: string }> {
  const project = await store.createProject({ name });
  const ws = await store.projectWorkspaceDir(project.id);
  await writeFile(join(ws, file), content);
  return { projectId: project.id, ws };
}

describe('project-local @project gezel', () => {
  it('derives the @project prompt from AGENTS.md and keeps identity stable', async () => {
    const { projectId } = await projectWithInstructionFile(
      'Acme API',
      'AGENTS.md',
      '# Acme API\nYou are the Acme API assistant.',
    );
    const created = await store.createProjectGezel(projectId, {
      name: 'Acme API',
      canonical: true,
    });
    const encoded = projectGezelId(projectId);
    expect(created.id).toBe(encoded);
    expect(created.scope).toBe('project');
    expect(created.about).toContain('Acme API assistant');
    expect(created.poppetje).toBeDefined();

    // Poppetje lives in app-data keyed by the encoded id — NOT in the repo.
    expect(existsSync(gezelPoppetjePath(home, encoded))).toBe(true);

    const detail = await store.getGezel(encoded);
    expect(detail?.about).toContain('Acme API assistant');

    // Editing AGENTS.md changes the prompt; identity (name) is unchanged.
    const ws = await store.projectWorkspaceDir(projectId);
    await writeFile(join(ws, 'AGENTS.md'), 'You are the NEW Acme assistant.');
    const after = await store.getGezel(encoded);
    expect(after?.about).toContain('NEW Acme assistant');
    expect(after?.name).toBe('Acme API');
  });

  it('honors precedence AGENTS.md > CLAUDE.md when both present', async () => {
    const { projectId, ws } = await projectWithInstructionFile('P', 'CLAUDE.md', 'from claude');
    await writeFile(join(ws, 'AGENTS.md'), 'from agents');
    await store.createProjectGezel(projectId, { name: 'P', canonical: true });
    const detail = await store.getGezel(projectGezelId(projectId));
    expect(detail?.about).toBe('from agents');
  });

  it('keeps project-local gezels out of the global roster but in the project roster', async () => {
    const { projectId } = await projectWithInstructionFile('Q', 'AGENTS.md', 'q prompt');
    await store.createProjectGezel(projectId, { name: 'Q', canonical: true });

    const global = await store.listGezels();
    expect(global.find((g) => g.id === projectGezelId(projectId))).toBeUndefined();

    const projectRoster = await store.listProjectGezels(projectId);
    expect(projectRoster.find((g) => g.id === projectGezelId(projectId))).toBeDefined();
    expect(projectRoster[0]?.scope).toBe('project');
  });

  it('refuses to write into an external workingDir without allowGezelWrites', async () => {
    const external = await mkdtemp(join(tmpdir(), 'lv-ext-'));
    try {
      const project = await store.createProject({ name: 'Ext', workingDir: external });
      await writeFile(join(external, 'AGENTS.md'), 'ext prompt');
      await expect(
        store.createProjectGezel(project.id, { name: 'Ext', canonical: true }),
      ).rejects.toThrow();
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

describe('project-local craftbooks', () => {
  it('writes, reads, and lists a project craftbook', async () => {
    const project = await store.createProject({ name: 'CB' });
    const now = nowIso();
    await store.writeProjectCraftbook(project.id, {
      id: 'proj-skill-demo',
      name: 'Demo',
      description: 'A demo skill',
      version: '1.0.0',
      basedOn: { name: 'Upstream demo', url: 'https://example.com/upstream-demo' },
      steps: [{ id: 'run', name: 'Run', prompt: 'Do the thing.', terminal: true }],
      entryStepId: 'run',
      triggers: ['demo'],
      createdAt: now,
      updatedAt: now,
    });

    const got = await store.getProjectCraftbook(project.id, 'proj-skill-demo');
    expect(got?.name).toBe('Demo');
    expect(got?.steps).toHaveLength(1);
    expect(got?.triggers).toEqual(['demo']);
    expect(got?.basedOn).toEqual({
      name: 'Upstream demo',
      url: 'https://example.com/upstream-demo',
    });

    const list = await store.listProjectCraftbooks(project.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.source).toBe('project');
    expect(list[0]?.basedOn?.name).toBe('Upstream demo');

    await store.deleteProjectCraftbook(project.id, 'proj-skill-demo');
    expect(await store.getProjectCraftbook(project.id, 'proj-skill-demo')).toBeNull();
  });

  it('round-trips paramSchema, command, and requirements', async () => {
    const project = await store.createProject({ name: 'CB Launcher' });
    const now = nowIso();
    await store.writeProjectCraftbook(project.id, {
      id: 'proj-review',
      name: 'Review',
      version: '1.0.0',
      steps: [{ id: 'run', name: 'Run', prompt: 'Review it.', terminal: true }],
      entryStepId: 'run',
      paramSchema: { type: 'object', properties: { focus: { type: 'string' } } },
      command: 'proj-review',
      requirements: [{ kind: 'github' }],
      createdAt: now,
      updatedAt: now,
    });

    const got = await store.getProjectCraftbook(project.id, 'proj-review');
    expect(got?.paramSchema).toEqual({ type: 'object', properties: { focus: { type: 'string' } } });
    expect(got?.command).toBe('proj-review');
    expect(got?.requirements).toEqual([{ kind: 'github' }]);
  });

  it('round-trips the project-type provenance sidecar', async () => {
    const project = await store.createProject({ name: 'CB Provenance' });
    expect(await store.readProjectCraftbookProvenance(project.id, 'nope')).toBeNull();

    const prov = {
      installedBy: 'project-type' as const,
      typeId: 'job-hunt',
      typeVersion: '1.0.0',
      bookVersion: '1.0.0',
      contentHash: 'sha256:abc',
      installedAt: nowIso(),
    };
    await store.writeProjectCraftbookProvenance(project.id, 'weekly-review', prov);
    expect(await store.readProjectCraftbookProvenance(project.id, 'weekly-review')).toEqual(prov);
    // The sidecar does not make the book listable — only real books list.
    expect(await store.listProjectCraftbooks(project.id)).toHaveLength(0);
  });
});

describe('encodeProjectGezelId round-trip', () => {
  it('is a legal path segment', () => {
    const id = encodeProjectGezelId('my-project', 'project');
    expect(id).toBe('proj__my-project__project');
    // No `:` or `/` — safe for filesystem + URL path params.
    expect(id).not.toMatch(/[:/]/);
  });
});
