import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTypeTool, ScriptRun } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { dispatchToolReaction, flattenRunOutput } from './reactions.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'reactions-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeRun(output: unknown): ScriptRun {
  return {
    id: 'run-1',
    projectId: 'p',
    scriptName: 'game-store',
    startedAt: '2026-07-18T00:00:00Z',
    status: 'ok',
    trigger: { kind: 'page', tool: 'user_move' },
    inputs: {},
    output,
    calls: [],
    logs: '',
  };
}

function reactionTool(overrides: Partial<ProjectTypeTool['reaction']> = {}): ProjectTypeTool {
  return {
    name: 'user_move',
    description: 'x',
    script: 'game-store',
    reaction: {
      gezel: 'checkers-player',
      prompt: 'Opponent played {{output.lastMove}} in {{tool}}. Style: {{personality}}.',
      ...overrides,
    },
  };
}

describe('flattenRunOutput', () => {
  it('flattens dot paths to depth two, stringifying objects', () => {
    const map = flattenRunOutput({
      board: 'ascii',
      stats: { moves: 3, nested: { deep: true } },
      list: [1, 2],
    });
    expect(map['output.board']).toBe('ascii');
    expect(map['output.stats.moves']).toBe(3);
    expect(map['output.stats.nested']).toBe('{"deep":true}');
    expect(map['output.list']).toBe('[1,2]');
    expect(typeof map.output).toBe('string');
  });

  it('handles primitives and absent output', () => {
    expect(flattenRunOutput(undefined)).toEqual({});
    expect(flattenRunOutput('plain')).toEqual({ output: 'plain' });
  });
});

describe('dispatchToolReaction', () => {
  it('targets the roster gezel matching the reaction templateId and renders the seed', async () => {
    const project = await store.createProject({ name: 'Game' });
    const decoy = await store.createGezel({ name: 'Decoy', role: 'Damspeler' });
    const player = await store.createGezel({
      name: 'Speler',
      role: 'Damspeler',
      templateId: 'checkers-player',
      templateVersion: '1.0.0',
    });
    await store.addGezelToProject(project.id, decoy.id);
    await store.addGezelToProject(project.id, player.id);

    const deliverReaction = vi.fn(async () => ({ sessionId: 's1' }));
    const result = await dispatchToolReaction(
      { store, chat: { deliverReaction } },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        params: { personality: 'peppy' },
        tool: reactionTool(),
        run: fakeRun({ lastMove: 'c3-d4', board: 'B' }),
      },
    );

    expect(result).toEqual({ delivered: true, gezelId: player.id });
    expect(deliverReaction).toHaveBeenCalledWith({
      projectId: project.id,
      gezelId: player.id,
      seed: '[Checkers page]: Opponent played c3-d4 in user_move. Style: peppy.',
    });
  });

  it('forwards hidden:true to the chat port when the reaction opts into hideSeed', async () => {
    const project = await store.createProject({ name: 'Quiet Game' });
    const player = await store.createGezel({
      name: 'Speler',
      role: 'Damspeler',
      templateId: 'checkers-player',
      templateVersion: '1.0.0',
    });
    await store.addGezelToProject(project.id, player.id);

    const deliverReaction = vi.fn(async () => ({ sessionId: 's1' }));
    await dispatchToolReaction(
      { store, chat: { deliverReaction } },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        params: { personality: 'peppy' },
        tool: reactionTool({ hideSeed: true }),
        run: fakeRun({ lastMove: 'c3-d4', board: 'B' }),
      },
    );

    expect(deliverReaction).toHaveBeenCalledWith({
      projectId: project.id,
      gezelId: player.id,
      seed: '[Checkers page]: Opponent played c3-d4 in user_move. Style: peppy.',
      hidden: true,
    });
  });

  it('falls back to the voorman, and reports no-target when neither exists', async () => {
    const project = await store.createProject({ name: 'Fallback' });
    const voorman = await store.createGezel({ name: 'Voor', role: 'Voorman' });
    await store.addGezelToProject(project.id, voorman.id);
    await store.updateProject(project.id, { voormanGezelId: voorman.id });

    const deliverReaction = vi.fn(async () => ({ sessionId: 's1' }));
    const withVoorman = await dispatchToolReaction(
      { store, chat: { deliverReaction } },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        tool: reactionTool(),
        run: fakeRun({}),
      },
    );
    expect(withVoorman.delivered).toBe(true);
    expect(withVoorman.gezelId).toBe(voorman.id);

    const bare = await store.createProject({ name: 'Bare' });
    const none = await dispatchToolReaction(
      { store, chat: { deliverReaction } },
      {
        project: (await store.getProject(bare.id))!,
        typeName: 'Checkers',
        tool: reactionTool(),
        run: fakeRun({}),
      },
    );
    expect(none).toEqual({ delivered: false, reason: 'no-target' });
  });

  it('skips inactive projects and reports engagement-off from the chat port', async () => {
    const project = await store.createProject({ name: 'Paused Game' });
    const player = await store.createGezel({
      name: 'Speler',
      role: 'Damspeler',
      templateId: 'checkers-player',
      templateVersion: '1.0.0',
    });
    await store.addGezelToProject(project.id, player.id);
    await store.updateProject(project.id, { status: 'readonly' });

    const deliverReaction = vi.fn(async () => ({ sessionId: 's1' }));
    const inactive = await dispatchToolReaction(
      { store, chat: { deliverReaction } },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        tool: reactionTool(),
        run: fakeRun({}),
      },
    );
    expect(inactive).toEqual({ delivered: false, reason: 'project-inactive' });
    expect(deliverReaction).not.toHaveBeenCalled();

    await store.updateProject(project.id, { status: 'active' });
    const offPort = vi.fn(async () => null);
    const off = await dispatchToolReaction(
      { store, chat: { deliverReaction: offPort } },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        tool: reactionTool(),
        run: fakeRun({}),
      },
    );
    expect(off).toEqual({ delivered: false, gezelId: player.id, reason: 'engagement-off' });
  });

  it('leaves unknown placeholders visible and survives a throwing chat port', async () => {
    const project = await store.createProject({ name: 'Odd' });
    const player = await store.createGezel({
      name: 'Speler',
      role: 'Damspeler',
      templateId: 'checkers-player',
      templateVersion: '1.0.0',
    });
    await store.addGezelToProject(project.id, player.id);

    const seen: string[] = [];
    const chat = {
      deliverReaction: vi.fn(async (args: { seed: string }) => {
        seen.push(args.seed);
        return { sessionId: 's1' };
      }),
    };
    await dispatchToolReaction(
      { store, chat },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        tool: reactionTool({ prompt: 'Known {{output.a}}; unknown {{ghost}}.' }),
        run: fakeRun({ a: 1 }),
      },
    );
    expect(seen[0]).toBe('[Checkers page]: Known 1; unknown {{ghost}}.');

    const boom = await dispatchToolReaction(
      {
        store,
        chat: {
          deliverReaction: vi.fn(async () => {
            throw new Error('bus down');
          }),
        },
      },
      {
        project: (await store.getProject(project.id))!,
        typeName: 'Checkers',
        tool: reactionTool(),
        run: fakeRun({}),
      },
    );
    expect(boom).toEqual({ delivered: false, gezelId: player.id, reason: 'send-failed' });
  });
});
