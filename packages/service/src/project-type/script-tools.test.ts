import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTypeTool } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import {
  reconcileScriptTools,
  resolveProjectScriptTools,
  scriptToolNamesFromEnv,
} from './script-tools.js';

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'script-tools-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('resolveProjectScriptTools', () => {
  it('resolves the applied type tools (with binds) from project provenance', async () => {
    const project = await store.createProject({ name: 'Learn Spanish' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer' },
    );
    expect(applied.toolsBound).toEqual(['record_session', 'advance_level']);

    const detail = await store.getProject(project.id);
    const tools = await resolveProjectScriptTools(catalog, detail);
    expect(tools.map((t) => t.name)).toEqual(['record_session', 'advance_level']);
    expect(tools[0]?.script).toBe('progress-store');
    expect(tools[0]?.bind).toEqual({ action: 'record' });
    expect(tools[1]?.bind).toEqual({ action: 'advance' });
  });

  it('returns [] for projects without type provenance', async () => {
    const project = await store.createProject({ name: 'Plain' });
    const detail = await store.getProject(project.id);
    expect(await resolveProjectScriptTools(catalog, detail)).toEqual([]);
    expect(await resolveProjectScriptTools(catalog, null)).toEqual([]);
  });

  it('returns [] when the type no longer resolves, without throwing', async () => {
    const tools = await resolveProjectScriptTools(catalog, {
      projectType: {
        id: 'ghost-type',
        version: '9.9.9',
        source: 'bundled',
        appliedAt: '2026-07-18T00:00:00Z',
      },
    });
    expect(tools).toEqual([]);
  });
});

describe('reconcileScriptTools', () => {
  const tool = (name: string): ProjectTypeTool => ({
    name,
    description: 'x',
    script: 'game-store',
  });
  const makeMove = [tool('make_move'), tool('get_board')];

  it('uses a successful resolve as the source of truth and seeds when it changed', () => {
    const plan = reconcileScriptTools(makeMove, [], true);
    expect(plan.effective.map((t) => t.name)).toEqual(['make_move', 'get_board']);
    expect(plan).toMatchObject({ seed: true, clear: false, reused: false });
  });

  it('does not seed when the resolve equals the persisted set (no write churn)', () => {
    const plan = reconcileScriptTools(makeMove, makeMove, true);
    expect(plan).toMatchObject({ seed: false, clear: false, reused: false });
    expect(plan.effective).toBe(makeMove);
  });

  it('reuses the persisted set when the resolve is empty but the type is still applied', () => {
    // The checkers "make_move not available" repair: a transient empty
    // resolve on a rebuild must not strip a live game's tools.
    const plan = reconcileScriptTools([], makeMove, true);
    expect(plan.effective).toBe(makeMove);
    expect(plan).toMatchObject({ seed: false, clear: false, reused: true });
  });

  it('clears the persisted set only when the type is genuinely un-applied', () => {
    const plan = reconcileScriptTools([], makeMove, false);
    expect(plan.effective).toEqual([]);
    expect(plan).toMatchObject({ seed: false, clear: true, reused: false });
  });

  it('stays empty (no clear) when there was nothing persisted', () => {
    const plan = reconcileScriptTools([], [], false);
    expect(plan).toMatchObject({ effective: [], seed: false, clear: false, reused: false });
  });
});

describe('scriptToolNamesFromEnv', () => {
  it('extracts names from a serialized payload', () => {
    const raw = JSON.stringify([
      { name: 'record_session', description: 'x', script: 's' },
      { name: 'advance_level', description: 'y', script: 's' },
    ]);
    expect(scriptToolNamesFromEnv(raw)).toEqual(['record_session', 'advance_level']);
  });

  it('tolerates garbage', () => {
    expect(scriptToolNamesFromEnv(undefined)).toEqual([]);
    expect(scriptToolNamesFromEnv('{broken')).toEqual([]);
    expect(scriptToolNamesFromEnv('{"a":1}')).toEqual([]);
    expect(scriptToolNamesFromEnv('[{"noName":true}, {"name":"ok_tool"}]')).toEqual(['ok_tool']);
  });
});
