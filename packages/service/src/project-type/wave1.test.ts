import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { ScriptRunner } from '../scripts/runner.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { applyProjectType } from './apply.js';
import { resolvePageTools, resolveProjectScriptTools } from './script-tools.js';

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

/**
 * Table-driven exercise of every SHIPPED Wave-1 bundled project type against
 * the real default CatalogService — one row per type, the same resolve+apply
 * contract for all of them. A break in any committed manifest, template,
 * script, or seed fails here with the type's name on it.
 */

interface Wave1Row {
  typeId: string;
  category: string;
  gezel: string;
  role: string;
  script: string;
  seeds: string[];
  craftbooks: string[];
  /** Tools that are page-only (excluded from the model surface). */
  pageTools?: string[];
  /** Seed keys that must render as JSON numbers (unquoted `{{param}}`). */
  numericSeedKeys?: Array<{ file: string; key: string }>;
}

const WAVE1: Wave1Row[] = [
  {
    typeId: 'household-budget',
    category: 'money',
    gezel: 'penningmeester',
    role: 'Penningmeester',
    script: 'budget-store',
    seeds: ['ledger.json'],
    craftbooks: ['subscription-audit', 'month-close'],
    pageTools: ['record_expense'],
  },
  {
    typeId: 'freelance-office',
    category: 'money',
    gezel: 'kantoormeester',
    role: 'Kantoormeester',
    script: 'office-store',
    seeds: ['invoices.json'],
    craftbooks: ['proposal-sow', 'weekly-review'],
  },
  {
    typeId: 'life-binder',
    category: 'money',
    gezel: 'archivaris',
    role: 'Archivaris',
    script: 'binder-store',
    seeds: ['documents.json'],
    craftbooks: ['annual-document-review'],
  },
  {
    typeId: 'household-manual',
    category: 'home',
    gezel: 'huismeester',
    role: 'Huismeester',
    script: 'house-store',
    seeds: ['systems.json'],
    craftbooks: ['seasonal-maintenance-sweep'],
  },
  {
    typeId: 'meal-planner',
    category: 'home',
    gezel: 'maaltijdplanner',
    role: 'Maaltijdplanner',
    script: 'kitchen-store',
    seeds: ['menu.json', 'pantry.json'],
    craftbooks: ['weekly-menu-plan'],
  },
  {
    typeId: 'caregiving-binder',
    category: 'home',
    gezel: 'zorgcoordinator',
    role: 'Zorgcoördinator',
    script: 'care-store',
    seeds: ['meds.json', 'care.json'],
    craftbooks: ['visit-prep'],
  },
  {
    typeId: 'event-planner',
    category: 'events',
    gezel: 'ceremoniemeester',
    role: 'Ceremoniemeester',
    script: 'event-store',
    seeds: ['guests.json', 'budget.json'],
    craftbooks: ['runbook'],
  },
  {
    typeId: 'trip-planner',
    category: 'events',
    gezel: 'reisleider',
    role: 'Reisleider',
    script: 'trip-store',
    seeds: ['trip.json', 'packing.json', 'journal.json'],
    craftbooks: ['pre-departure-countdown'],
    pageTools: ['mark_packed'],
  },
  {
    typeId: 'fundraiser-hq',
    category: 'events',
    gezel: 'aanjager',
    role: 'Aanjager',
    script: 'drive-store',
    seeds: ['donations.json'],
    craftbooks: ['social-thread', 'drive-wrap-up'],
    numericSeedKeys: [{ file: 'donations.json', key: 'goalCents' }],
  },
  {
    typeId: 'fitness-coach',
    category: 'growth',
    gezel: 'coach',
    role: 'Coach',
    script: 'training-store',
    seeds: ['training.json'],
    craftbooks: ['weekly-review'],
    numericSeedKeys: [{ file: 'training.json', key: 'weeklyTarget' }],
  },
  {
    typeId: 'novel-writing-room',
    category: 'writing',
    gezel: 'schrijfmaat',
    role: 'Schrijfmaat',
    script: 'manuscript-store',
    seeds: ['sessions.json', 'chapters.json'],
    craftbooks: ['copy-review', 'ebook-compile'],
    numericSeedKeys: [{ file: 'sessions.json', key: 'weeklyWordGoal' }],
  },
];

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wave1-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe.each(WAVE1)('Wave-1 bundled project type: $typeId', (row) => {
  it('resolves with the declared category, gezel, tool binds, and page', async () => {
    const detail = await catalog.get('project-type', row.typeId);
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');

    expect(detail.manifest.category).toBe(row.category);
    expect(detail.manifest.gezels).toEqual([{ templateId: row.gezel, voorman: true }]);
    expect(detail.manifest.craftbooks).toEqual(row.craftbooks);
    expect(detail.manifest.pages?.entry).toBe('dashboard/index.html');
    expect(detail.manifest.pages?.reads?.length ?? 0).toBeGreaterThan(0);

    // Every tool multiplexes the type's single store script on a bound action.
    expect(detail.manifest.tools.length).toBeGreaterThan(0);
    for (const tool of detail.manifest.tools) {
      expect(tool.script).toBe(row.script);
      expect(typeof tool.bind?.action).toBe('string');
    }
    // Reactions only fire via page invokes — any reaction-bearing tool must be
    // page-listed (Wave 1 currently ships none; the invariant still holds).
    for (const tool of detail.manifest.tools) {
      if (tool.reaction) expect(detail.manifest.pages?.tools).toContain(tool.name);
    }
    expect(detail.manifest.pages?.tools ?? []).toEqual(row.pageTools ?? []);
  });

  it('applies: voorman role, provenance-marked script, rendered seeds, craftbooks', async () => {
    const project = await store.createProject({ name: `Wave1 ${row.typeId}` });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: row.typeId },
    );

    expect(applied.gezelsCreated).toHaveLength(1);
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    const gezel = await store.getGezel(applied.gezelsCreated[0]!.id);
    expect(gezel?.role).toBe(row.role);

    expect(applied.scriptsInstalled).toEqual([row.script]);
    const scriptBody = await readFile(projectScriptFile(home, project.id, row.script), 'utf8');
    expect(
      scriptBody.startsWith(`// @gezel-project-type: ${row.typeId}@${applied.version}\n`),
    ).toBe(true);

    expect(applied.craftbooksInstalled).toEqual(row.craftbooks);

    const workspaceDir = await store.projectWorkspaceDir(project.id);
    for (const seed of row.seeds) {
      const raw = await readFile(join(workspaceDir, seed), 'utf8');
      expect(raw, `${seed} left an unrendered placeholder`).not.toContain('{{');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const check of row.numericSeedKeys ?? []) {
        if (check.file === seed) {
          expect(typeof parsed[check.key], `${seed}#${check.key} must render unquoted`).toBe(
            'number',
          );
        }
      }
    }

    const about = (await store.getProject(project.id))?.about ?? '';
    expect(about.length).toBeGreaterThan(0);
    expect(about).not.toContain('{{');
  });

  it('executes the shipped store script end-to-end in the sandbox', async () => {
    const project = await store.createProject({ name: `Run ${row.typeId}` });
    await applyProjectType({ store, catalog, home }, { projectId: project.id, typeId: row.typeId });
    // The installed script byte-matches the catalog, so the provenance-
    // trusted lane executes it on every platform — including Windows and
    // Linux, where denyNet has no OS boundary.
    const chat = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['copilot', new MockProvider({ name: 'copilot' })]],
      catalog,
      secrets: new FileSecretStore(home),
    });
    const runner = new ScriptRunner({ store, chat, catalog });
    try {
      const run = await runner.run({
        projectId: project.id,
        scriptName: row.script,
        inputs: { action: 'status' },
        trigger: { kind: 'manual', userInitiated: true },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe('ok');
      expect(String((run.output as { summary?: unknown } | undefined)?.summary ?? '')).not.toBe('');
    } finally {
      await chat.drainBackground();
      await chat.shutdown();
    }
  }, 60_000);

  it('keeps page-only tools off the model surface', async () => {
    const project = await store.createProject({ name: `Surface ${row.typeId}` });
    await applyProjectType({ store, catalog, home }, { projectId: project.id, typeId: row.typeId });
    const detail = await store.getProject(project.id);

    const modelTools = (await resolveProjectScriptTools(catalog, detail)).map((t) => t.name);
    const pageTools = await resolvePageTools(catalog, detail);
    for (const name of row.pageTools ?? []) {
      expect(modelTools).not.toContain(name);
      expect(pageTools?.tools.map((t) => t.name)).toContain(name);
    }
    if (!row.pageTools?.length) {
      expect(pageTools?.tools ?? []).toEqual([]);
    }
  });
});
