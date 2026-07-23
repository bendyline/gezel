import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';

/**
 * End-to-end exercise of the SHIPPED Job Hunt bundled project type
 * (packages/catalog/data/project-types/jo/job-hunt) against the real default
 * CatalogService. The full-rails exemplar: the first two-gezel crew, named
 * script-tools with binds, craftbook copy-install, and a consent-gated
 * schedule — a break in any committed piece fails here. See
 * docs/project-types.md.
 */

const CRAFTBOOKS = [
  'tailor-resume',
  'company-research-brief',
  'mock-interview',
  'offer-compare',
  'weekly-pipeline-review',
];

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'job-hunt-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Job Hunt bundled project type', () => {
  it('resolves from the bundled catalog with the full composition', async () => {
    const detail = await catalog.get('project-type', 'job-hunt');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    expect(detail.manifest.extends).toBe('job-hunt');
    expect(detail.manifest.meesterManaged).toBe(false);
    expect(detail.manifest.gezels).toEqual([
      { templateId: 'career-coach', voorman: true },
      { templateId: 'mock-interviewer', voorman: false },
    ]);
    expect(Object.keys(detail.manifest.scripts ?? {})).toContain('application-store');
    expect(detail.manifest.tools.map((t) => t.name)).toEqual([
      'record_application',
      'advance_stage',
      'log_activity',
      'pipeline_status',
    ]);
    // Every tool binds an action — the script multiplexes on it.
    for (const tool of detail.manifest.tools) {
      expect(tool.script).toBe('application-store');
      expect(typeof tool.bind?.action).toBe('string');
    }
    expect(detail.manifest.craftbooks).toEqual(CRAFTBOOKS);
    expect(detail.manifest.schedules).toEqual([
      { cron: '0 17 * * 5', craftbook: 'weekly-pipeline-review', consent: 'ask', overlap: 'skip' },
    ]);
    expect(detail.manifest.pages?.entry).toBe('dashboard/index.html');
    expect(detail.manifest.pages?.reads?.map((r) => r.path)).toEqual([
      'pipeline.json',
      'activity.json',
    ]);
  });

  it('applies: two-gezel crew with the coach as voorman', async () => {
    const project = await store.createProject({ name: 'Staff Engineer Hunt' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'job-hunt', params: { role: 'Staff Engineer' } },
    );

    // First two-gezel coverage in the repo: both created, first voorman wins.
    expect(applied.gezelsCreated).toHaveLength(2);
    expect(applied.gezelsCreated[0]?.templateId).toBe('career-coach');
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    expect(applied.gezelsCreated[1]?.templateId).toBe('mock-interviewer');
    expect(applied.gezelsCreated[1]?.voorman).toBe(false);

    const detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBe(applied.gezelsCreated[0]?.id);
    const coach = await store.getGezel(applied.gezelsCreated[0]!.id);
    const interviewer = await store.getGezel(applied.gezelsCreated[1]!.id);
    expect(coach?.role).toBe('Loopbaancoach');
    expect(interviewer?.role).toBe('Oefen-interviewer');
  });

  it('installs the script and renders both seeds with the role param', async () => {
    const project = await store.createProject({ name: 'Hunt Seeds' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'job-hunt', params: { role: 'Staff Engineer' } },
    );

    expect(applied.scriptsInstalled).toEqual(['application-store']);
    const scriptBody = await readFile(
      projectScriptFile(home, project.id, 'application-store'),
      'utf8',
    );
    expect(scriptBody.startsWith('// @gezel-project-type: job-hunt@1.0.0\n')).toBe(true);
    expect(scriptBody).toContain("from '@bendyline/gezel-sdk/stores'");

    expect(applied.workspaceSeeded).toEqual(['pipeline.json', 'activity.json']);
    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const pipeline = JSON.parse(await readFile(join(workspaceDir, 'pipeline.json'), 'utf8'));
    expect(pipeline.role).toBe('Staff Engineer');
    expect(pipeline.stages).toHaveLength(5);
    expect(pipeline.records).toEqual([]);
    const activity = JSON.parse(await readFile(join(workspaceDir, 'activity.json'), 'utf8'));
    expect(activity.events).toEqual([]);

    expect(detailAbout(await store.getProject(project.id))).toContain('Staff Engineer');
    expect(detailAbout(await store.getProject(project.id))).not.toContain('{{');
  });

  it('renders cleanly on the defaults path (no params)', async () => {
    const project = await store.createProject({ name: 'Hunt Defaults' });
    await applyProjectType({ store, catalog, home }, { projectId: project.id, typeId: 'job-hunt' });
    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const pipeline = JSON.parse(await readFile(join(workspaceDir, 'pipeline.json'), 'utf8'));
    expect(pipeline.role).toBe('Software Engineer');
    const detail = await store.getProject(project.id);
    expect(detail?.about ?? '').not.toContain('{{');
    expect(detail?.missionObjectives ?? '').not.toContain('{{');
  });

  it('exercises every Phase-1 rail: tools bound, craftbooks installed, schedule consented', async () => {
    const project = await store.createProject({ name: 'Full Rails' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'job-hunt' },
    );

    // Named script-tools: type-owned references bound live per-session.
    expect(applied.toolsBound).toEqual([
      'record_application',
      'advance_stage',
      'log_activity',
      'pipeline_status',
    ]);

    // Craftbooks: all five copy-installed project-local with provenance.
    expect(applied.craftbooksInstalled).toEqual(CRAFTBOOKS);
    expect(applied.deferred.craftbooks).toEqual([]);
    for (const id of CRAFTBOOKS) {
      expect(await store.getProjectCraftbook(project.id, id)).not.toBeNull();
      const prov = await store.readProjectCraftbookProvenance(project.id, id);
      expect(prov?.typeId).toBe('job-hunt');
    }

    // Schedule: one paused host assigned to the coach, consent question pending.
    expect(applied.schedulesCreated).toHaveLength(1);
    expect(applied.schedulesCreated[0]).toMatchObject({
      craftbook: 'weekly-pipeline-review',
      cron: '0 17 * * 5',
      consent: 'ask',
      status: 'paused',
      created: true,
    });
    expect(applied.deferred.schedules).toBe(0);
    const hosts = await store.listProjectTasks(project.id);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.status).toBe('paused');
    expect(hosts[0]?.origin).toEqual({
      kind: 'project-type-schedule',
      typeId: 'job-hunt',
      scheduleKey: 'weekly-pipeline-review',
    });
    expect(hosts[0]?.spawnsCraftbook?.id).toBe('weekly-pipeline-review');
    expect(hosts[0]?.assignee).toEqual({
      kind: 'gezel',
      gezelId: applied.gezelsCreated[0]?.id,
    });
    const questions = await store.listProjectQuestions(project.id);
    const approval = questions.find((q) => q.intent?.kind === 'schedule-approval');
    expect(approval?.taskRef).toBe(hosts[0]?.ref);

    // Taxonomy inheritance + provenance + nudge default.
    const detail = await store.getProject(project.id);
    expect(detail?.projectTypeId).toBe('job-hunt');
    expect(detail?.projectType?.id).toBe('job-hunt');
    expect(detail?.nudgeConfig?.enabled).toBe(false);
  });
});

function detailAbout(detail: { about?: string } | null): string {
  return detail?.about ?? '';
}
