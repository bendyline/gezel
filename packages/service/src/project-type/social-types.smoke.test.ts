import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import { resolvePageTools, resolveProjectScriptTools } from './script-tools.js';

/**
 * Resolve+apply smoke for the marketing/social project types (social-feed,
 * image-feed). Gated on GEZEL_GILDE_DATA_DIR because the types ship in a
 * gilde version newer than the bundled pin — run with the override pointed
 * at a local gilde checkout. Drop the gate (fold rows into wave1.test.ts's
 * table) once the @bendyline/gilde pin is bumped past their release.
 */

const localGilde = process.env.GEZEL_GILDE_DATA_DIR;

interface SocialRow {
  typeId: string;
  category: string;
  crew: Array<{ templateId: string; voorman?: boolean }>;
  entry: string;
  seeds: string[];
}

const SOCIAL: SocialRow[] = [
  {
    typeId: 'social-feed',
    category: 'communication',
    crew: [{ templateId: 'omroeper', voorman: true }, { templateId: 'copywriter' }],
    entry: 'dashboard/index.html',
    seeds: ['voice-guide.md', 'posts/index.json'],
  },
  {
    typeId: 'image-feed',
    category: 'creative',
    crew: [{ templateId: 'omroeper', voorman: true }, { templateId: 'image-generator' }],
    entry: 'gallery/index.html',
    seeds: ['style-guide.md', 'posts/index.json'],
  },
];

const CRAFTBOOKS = ['draft-social-post', 'social-digest', 'reception-report'];

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'social-types-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe.skipIf(!localGilde).each(SOCIAL)('social project type: $typeId', (row) => {
  it('resolves with crew, craftbooks, v1 page surface, and schedules', async () => {
    const detail = await catalog.get('project-type', row.typeId);
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');

    expect(detail.manifest.category).toBe(row.category);
    expect(detail.manifest.extends).toBe('social-media');
    // The schema defaults `voorman: false`, so compare normalized shapes.
    expect(
      detail.manifest.gezels.map((g) => ({ templateId: g.templateId, voorman: !!g.voorman })),
    ).toEqual(row.crew.map((g) => ({ templateId: g.templateId, voorman: !!g.voorman })));
    expect(detail.manifest.craftbooks).toEqual(CRAFTBOOKS);
    expect(detail.manifest.pages?.entry).toBe(row.entry);
    expect(detail.manifest.pages?.api).toBe(1);
    // Reads must include the posts tree and the connector-corpus surface the
    // analytics view depends on.
    const reads = detail.manifest.pages?.reads ?? [];
    expect(reads.some((r) => r.source === 'workspace' && r.path === 'posts')).toBe(true);
    expect(reads.some((r) => r.source === 'artifacts' && r.path === 'data')).toBe(true);
    // Every tool multiplexes posts-store on a bound action; reaction tools are
    // page-listed (the reaction-only-via-page invariant).
    expect(detail.manifest.tools.length).toBeGreaterThan(0);
    for (const tool of detail.manifest.tools) {
      expect(tool.script).toBe('posts-store');
      expect(typeof tool.bind?.action).toBe('string');
      if (tool.reaction) expect(detail.manifest.pages?.tools).toContain(tool.name);
    }
    const schedules = detail.manifest.schedules ?? [];
    expect(schedules.map((s) => s.craftbook).sort()).toEqual(['reception-report', 'social-digest']);
    for (const schedule of schedules) expect(schedule.consent).toBe('ask');
  });

  it('applies: omroeper voorman, provenance-marked posts-store, rendered seeds', async () => {
    const project = await store.createProject({ name: `Social ${row.typeId}` });
    const applied = await applyProjectType(
      { store, catalog, home },
      {
        projectId: project.id,
        typeId: row.typeId,
        params: { brand: 'Bendyline', voice: 'warm and direct', cadence: '3 posts a week' },
      },
    );

    expect(applied.gezelsCreated.length).toBe(row.crew.length);
    const voorman = applied.gezelsCreated.find((g) => g.voorman);
    expect(voorman).toBeDefined();
    const gezel = await store.getGezel(voorman!.id);
    expect(gezel?.role).toBe('Omroeper');

    expect(applied.scriptsInstalled).toEqual(['posts-store']);
    const scriptBody = await readFile(projectScriptFile(home, project.id, 'posts-store'), 'utf8');
    expect(
      scriptBody.startsWith(`// @gezel-project-type: ${row.typeId}@${applied.version}\n`),
    ).toBe(true);

    expect(applied.craftbooksInstalled).toEqual(CRAFTBOOKS);

    const workspaceDir = await store.projectWorkspaceDir(project.id);
    for (const seed of row.seeds) {
      const raw = await readFile(join(workspaceDir, seed), 'utf8');
      expect(raw, `${seed} left an unrendered placeholder`).not.toContain('{{');
    }

    const about = (await store.getProject(project.id))?.about ?? '';
    expect(about).toContain('Bendyline');
    expect(about).not.toContain('{{');
  });

  it('splits the tool surface: page-only twins off the model surface', async () => {
    const project = await store.createProject({ name: `Surface ${row.typeId}` });
    await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: row.typeId, params: { brand: 'B' } },
    );
    const detail = await store.getProject(project.id);
    const pageTools = await resolvePageTools(catalog, detail);
    const modelTools = await resolveProjectScriptTools(catalog, detail);
    const pageNames = (pageTools?.tools ?? []).map((t) => t.name);
    const modelNames = modelTools.map((t) => t.name);

    expect(pageNames).toContain('page_set_status');
    for (const name of pageNames) expect(modelNames).not.toContain(name);
    // The model keeps its own post surface (the page-only twins must not
    // amputate it — the schema's two-names-one-script pattern).
    for (const name of ['list_posts', 'get_post', 'create_post', 'update_post']) {
      expect(modelNames).toContain(name);
    }
  });
});
