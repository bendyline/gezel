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
 * End-to-end exercise of the SHIPPED Checkers bundled project type — the
 * interactive-page exemplar: split page/model tool surfaces, a reaction on
 * the page's `user_move`, and an engine-generated seed. Uses the real
 * default CatalogService so a break in any committed piece fails here.
 */

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'checkers-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Checkers bundled project type', () => {
  it('resolves with split page/model tool surfaces and a page-listed reaction', async () => {
    const detail = await catalog.get('project-type', 'checkers');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');

    expect(detail.manifest.category).toBe('game');
    expect(detail.manifest.tabVisibility).toEqual({
      overview: false,
      tasks: false,
      approvals: false,
      workspace: false,
      artifacts: false,
      map: false,
    });
    expect(detail.manifest.gezels).toEqual([{ templateId: 'checkers-player', voorman: true }]);
    expect(detail.manifest.pages?.entry).toBe('board/index.html');
    expect(detail.manifest.pages?.tools).toEqual(['user_move', 'new_game']);
    expect(detail.manifest.tools.map((t) => t.name)).toEqual([
      'get_board',
      'make_move',
      'user_move',
      'new_game',
    ]);
    expect(detail.manifest.tools.find((t) => t.name === 'new_game')?.inputs).toMatchObject({
      properties: { forceCaptures: { type: 'boolean' } },
    });
    expect(detail.manifest.params).toMatchObject({
      properties: {
        playStyle: {
          enum: ['Opponent', 'Instructor'],
          default: 'Opponent',
        },
      },
    });

    // The reaction lives on the page tool and targets the opponent template.
    const userMove = detail.manifest.tools.find((t) => t.name === 'user_move');
    expect(userMove?.reaction?.gezel).toBe('checkers-player');
    expect(userMove?.reaction?.prompt).toContain('{{output.board}}');
    expect(userMove?.reaction?.prompt).toContain('Style: {{playStyle}}');
    expect(userMove?.reaction?.prompt).toContain('do not volunteer advice');
    // Hard rule: every reaction-bearing tool is page-listed (reactions only
    // fire via page invokes).
    for (const tool of detail.manifest.tools) {
      if (tool.reaction) expect(detail.manifest.pages?.tools).toContain(tool.name);
    }
    // Every tool multiplexes game-store on a bound action.
    for (const tool of detail.manifest.tools) {
      expect(tool.script).toBe('game-store');
      expect(typeof tool.bind?.action).toBe('string');
    }
  });

  it('applies: Damspeler voorman, provenance-marked script, engine-exact seed', async () => {
    const project = await store.createProject({ name: 'Checkers Night' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'checkers' },
    );

    expect(applied.gezelsCreated).toHaveLength(1);
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    const player = await store.getGezel(applied.gezelsCreated[0]!.id);
    expect(player?.role).toBe('Damspeler');

    expect(applied.scriptsInstalled).toEqual(['game-store']);
    const scriptBody = await readFile(projectScriptFile(home, project.id, 'game-store'), 'utf8');
    expect(scriptBody.startsWith('// @gezel-project-type: checkers@1.1.0\n')).toBe(true);

    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const seed = JSON.parse(await readFile(join(workspaceDir, 'game.json'), 'utf8'));
    expect(seed.turn).toBe('user');
    expect(seed.status).toBe('playing');
    expect(seed.forceCaptures).toBe(true);
    expect(seed.squares).toHaveLength(64);
    expect([...seed.squares].filter((c: string) => c !== '.')).toHaveLength(24);
    expect(seed.legalMoves).toHaveLength(7);

    const appliedProject = await store.getProject(project.id);
    const about = appliedProject?.about ?? '';
    expect(about).toContain('peppy');
    expect(about).toContain('Opponent');
    expect(about).not.toContain('{{');
    expect(appliedProject?.tabVisibility).toEqual({
      overview: false,
      tasks: false,
      approvals: false,
      workspace: false,
      artifacts: false,
      map: false,
    });
  });

  it('splits the session tool surface: page tools never reach the model', async () => {
    const project = await store.createProject({ name: 'Surface Split' });
    await applyProjectType(
      { store, catalog, home },
      {
        projectId: project.id,
        typeId: 'checkers',
        params: { playStyle: 'Instructor' },
      },
    );
    const detail = await store.getProject(project.id);

    const modelTools = await resolveProjectScriptTools(catalog, detail);
    expect(modelTools.map((t) => t.name)).toEqual(['get_board', 'make_move']);

    const pageTools = await resolvePageTools(catalog, detail);
    expect(pageTools?.typeName).toBe('Checkers');
    expect(pageTools?.tools.map((t) => t.name)).toEqual(['user_move', 'new_game']);
    expect(pageTools?.params).toEqual({ personality: 'peppy', playStyle: 'Instructor' });
  });
});
