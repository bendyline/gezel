import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredInstruction, DiscoveredSkill } from '@bendyline/gezel';
import { projectGezelId } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import {
  type ImportSyncDeps,
  approvePendingImport,
  ensureProjectVoorman,
  syncProjectImports,
} from './import-sync.js';
import { sha256 } from './instruction-scanner.js';

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lv-importsync-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A chat stub: translate path returns a valid SDK script; throws if unexpectedly called. */
function fakeChat(translation?: string): ChatManager {
  return {
    async oneShotCompletion() {
      if (!translation) throw new Error('oneShotCompletion should not have been called');
      return translation;
    },
  } as unknown as ChatManager;
}

/** Assemble the import-sync deps with the shared store/catalog and a chat stub. */
function deps(chat?: ChatManager): ImportSyncDeps {
  return { store, chat: chat ?? fakeChat(), home, catalog };
}

/**
 * Write an instruction file into the project's workspace and return the
 * matching discovered entry — mirroring what the indexer's scanner produces.
 */
async function seedInstruction(
  projectId: string,
  source: string,
  content: string,
): Promise<DiscoveredInstruction> {
  const ws = await store.projectWorkspaceDir(projectId);
  const abs = join(ws, source);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content);
  return {
    source,
    origin: source === 'AGENTS.md' ? 'agents' : source === 'CLAUDE.md' ? 'claude' : 'copilot',
    content,
    hash: sha256(content),
    mtimeMs: 0,
  };
}

/**
 * Write a real SKILL.md into the project's workspace and return the
 * discovered entry — the sync lane re-reads the file from disk (the
 * indexed body is stripped/capped), so the file must actually exist.
 */
async function seedSkill(
  projectId: string,
  name: string,
  raw: string,
  hasShellScripts = false,
): Promise<DiscoveredSkill> {
  const ws = await store.projectWorkspaceDir(projectId);
  const dir = join(ws, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), raw);
  return {
    name,
    source: `.claude/skills/${name}/SKILL.md`,
    origin: 'claude',
    description: `${name} skill`,
    body: raw,
    hasShellScripts,
  };
}

describe('syncProjectImports — instruction file → About', () => {
  it('no longer mints a @project gezel from AGENTS.md (deprecated)', async () => {
    const project = await store.createProject({ name: 'My Service' });
    const instr = [await seedInstruction(project.id, 'AGENTS.md', 'You are the My Service agent.')];
    await syncProjectImports(deps(), project.id, instr, []);

    expect(await store.getGezel(projectGezelId(project.id))).toBeNull();
  });

  it('merges the instruction file into the project About', async () => {
    const project = await store.createProject({ name: 'My Service' });
    const instr = [await seedInstruction(project.id, 'AGENTS.md', 'Build the thing carefully.')];
    await syncProjectImports(deps(), project.id, instr, []);

    const detail = await store.getProject(project.id);
    expect(detail?.about ?? '').toContain('Build the thing carefully.');
    expect(detail?.about ?? '').toContain('imported from AGENTS.md');
  });

  it('does not duplicate the imported About block on an unchanged re-scan', async () => {
    const project = await store.createProject({ name: 'Svc' });
    const instr = [await seedInstruction(project.id, 'AGENTS.md', 'prompt v1')];
    await syncProjectImports(deps(), project.id, instr, []);
    await syncProjectImports(deps(), project.id, instr, []);

    const detail = await store.getProject(project.id);
    const occurrences = (detail?.about ?? '').split('gezel:instructions:start').length - 1;
    expect(occurrences).toBe(1);
  });

  it('still refreshes an EXISTING @project gezel (back-compat)', async () => {
    const project = await store.createProject({ name: 'Legacy' });
    // Simulate a project imported before the deprecation: it already has a
    // canonical @project gezel on disk.
    await store.createProjectGezel(project.id, { name: 'Legacy', canonical: true });
    const instr = [await seedInstruction(project.id, 'AGENTS.md', 'Legacy agent guidance.')];
    await syncProjectImports(deps(), project.id, instr, []);

    const gezel = await store.getGezel(projectGezelId(project.id));
    expect(gezel).not.toBeNull();
    // about is read live from the instruction file.
    expect(gezel?.about).toContain('Legacy agent guidance.');
  });
});

describe('ensureProjectVoorman', () => {
  it('promotes a project-member gezel when one exists', async () => {
    const project = await store.createProject({ name: 'Imported Repo' });
    const g = await store.createGezel({ name: 'Sakura', role: 'Developer' });
    await store.addGezelToProject(project.id, g.id);

    await ensureProjectVoorman(deps(), project.id);

    const detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBe(g.id);
    expect(detail?.voormanAutoAssignedAt).toBeTruthy();
  });

  it('recruits a real global voorman from the template when there is nobody to promote', async () => {
    const project = await store.createProject({ name: 'Empty' });

    await ensureProjectVoorman(deps(), project.id);

    const detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBeTruthy();
    expect(detail?.voormanAutoAssignedAt).toBeTruthy();
    // The recruited voorman is a real GLOBAL gezel (not a project-local one).
    const global = await store.listGezels();
    expect(global.some((g) => g.id === detail?.voormanGezelId)).toBe(true);
  });

  it('never recruits a separate voorman for a solo project with nobody to promote', async () => {
    // Solo types (games, the chat room) run one gezel — the ambachtsman IS
    // the lead. A solo project with an empty roster must be left voorman-less
    // rather than getting a confusing second recruited "person".
    const project = await store.createProject({ name: 'Checkers', mode: 'solo' });

    await ensureProjectVoorman(deps(), project.id);

    const detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBeUndefined();
  });

  it('still promotes an existing roster member for a solo project', async () => {
    const project = await store.createProject({ name: 'Checkers', mode: 'solo' });
    const damspeler = await store.createGezel({ name: 'Ezekiel', role: 'Damspeler' });
    await store.addGezelToProject(project.id, damspeler.id);

    await ensureProjectVoorman(deps(), project.id);

    const detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBe(damspeler.id);
  });

  it('marks an existing voorman and never re-populates after a manual clear', async () => {
    const project = await store.createProject({ name: 'Has Lead' });
    const lead = await store.createGezel({ name: 'Lead' });
    const other = await store.createGezel({ name: 'Other' });
    await store.updateProject(project.id, { voormanGezelId: lead.id });

    // Already has a voorman → only records the ensured marker.
    await ensureProjectVoorman(deps(), project.id);
    let detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBe(lead.id);
    expect(detail?.voormanAutoAssignedAt).toBeTruthy();

    // User deliberately clears it; a later scan must NOT re-assign anyone.
    await store.updateProject(project.id, { voormanGezelId: null });
    await store.addGezelToProject(project.id, other.id);
    await ensureProjectVoorman(deps(), project.id);
    detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBeUndefined();
  });
});

describe('syncProjectImports — skills', () => {
  it('writes a prose-only craftbook immediately for a skill with no shell', async () => {
    const project = await store.createProject({ name: 'P' });
    const s = await seedSkill(project.id, 'greeter', '# Greeter\n\nSay hello to the user.');
    await syncProjectImports(deps(), project.id, [], [s]);
    const list = await store.listProjectCraftbooks(project.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('proj-skill-greeter');
    expect(list[0]?.source).toBe('project');
  });

  it('breaks phase headings into a multi-step book', async () => {
    const project = await store.createProject({ name: 'P' });
    const raw = [
      '---',
      'name: builder',
      '---',
      '',
      '# Builder',
      '',
      'Build things.',
      '',
      '## Phase 1: Plan',
      '',
      'Plan the work.',
      '',
      '## Phase 2: Build',
      '',
      'Do the work.',
    ].join('\n');
    const s = await seedSkill(project.id, 'builder', raw);
    await syncProjectImports(deps(), project.id, [], [s]);
    const book = await store.getProjectCraftbook(project.id, 'proj-skill-builder');
    expect(book?.steps.map((st) => st.id)).toEqual(['phase-1', 'phase-2']);
    expect(book?.steps[0]?.next).toBe('phase-2');
    expect(book?.steps[1]?.terminal).toBe(true);
  });

  it('queues a statically-transpiled shell block for review — the LLM is never called', async () => {
    const project = await store.createProject({ name: 'P' });
    const raw = [
      '# Tester',
      '',
      '## Phase 1: Test',
      '',
      'Run the tests:',
      '',
      '```bash',
      'npm test',
      '```',
      '',
      '## Phase 2: Report',
      '',
      'Summarize the results.',
    ].join('\n');
    const s = await seedSkill(project.id, 'tester', raw, true);
    // deps() default chat stub THROWS if oneShotCompletion is called —
    // the auto lane is static-only by policy (user decision).
    await syncProjectImports(deps(), project.id, [], [s]);

    // Nothing written yet — it's pending review.
    expect(await store.listProjectCraftbooks(project.id)).toHaveLength(0);
    const pending = await store.readPendingImports(project.id);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.scripts).toHaveLength(1);
    expect(pending.items[0]?.scripts[0]?.origin).toBe('static');
    expect(pending.items[0]?.scripts[0]?.confidence).toBe(1);
    expect(pending.items[0]?.scripts[0]?.body).toContain('run_package_script');

    // Approving writes the craftbook with the script inline.
    const approvedId = await approvePendingImport(
      deps(),
      project.id,
      pending.items[0]!.skillSource,
    );
    expect(approvedId).toBe('proj-skill-tester');
    const book = await store.getProjectCraftbook(project.id, 'proj-skill-tester');
    expect(Object.keys(book?.scripts ?? {})).toHaveLength(1);
    expect((await store.readPendingImports(project.id)).items).toHaveLength(0);
  });

  it('keeps a non-static shell block as prose and writes immediately', async () => {
    const project = await store.createProject({ name: 'P' });
    const raw = ['# Checker', '', 'Check state:', '', '```bash', 'git status', '```'].join('\n');
    const s = await seedSkill(project.id, 'checker', raw, true);
    await syncProjectImports(deps(), project.id, [], [s]);
    // git has no static mapping → block stays prose → nothing to review.
    const list = await store.listProjectCraftbooks(project.id);
    expect(list).toHaveLength(1);
    expect((await store.readPendingImports(project.id)).items).toHaveLength(0);
    const book = await store.getProjectCraftbook(project.id, 'proj-skill-checker');
    expect(book?.steps[0]?.prompt).toContain('git status');
    expect(book?.scripts).toBeUndefined();
  });

  it('queues a persona-shaped skill; approval mints the project gezel', async () => {
    const project = await store.createProject({ name: 'P' });
    const raw = [
      '# Office Hours',
      '',
      'You are a **startup mentor**. You challenge premises before solutions.',
      '',
      '## Phase 1: Listen',
      '',
      'Gather context.',
      '',
      '## Phase 2: Challenge',
      '',
      'Push back on the premise.',
    ].join('\n');
    const s = await seedSkill(project.id, 'office-hours', raw);
    await syncProjectImports(deps(), project.id, [], [s]);

    // Persona → queued even with zero scripts; no gezel exists yet.
    expect(await store.listProjectCraftbooks(project.id)).toHaveLength(0);
    const pending = await store.readPendingImports(project.id);
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.persona?.role).toBe('startup mentor');

    await approvePendingImport(deps(), project.id, pending.items[0]!.skillSource);
    const detail = await store.getProject(project.id);
    const memberRoles = await Promise.all(
      (detail?.gezelIds ?? []).map(async (id) => (await store.getGezel(id))?.role ?? ''),
    );
    expect(memberRoles.map((r) => r.toLowerCase())).toContain('startup mentor');
    const book = await store.getProjectCraftbook(project.id, 'proj-skill-office-hours');
    expect(book?.steps[0]?.suggestedRole).toBe('startup mentor');
  });
});
