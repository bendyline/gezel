import type { ScriptCapability } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import type { TaskManager } from '../tasks/manager.js';
import {
  CapabilityDeniedError,
  type DispatcherContext,
  type DispatcherDeps,
  buildDispatcher,
} from './dispatcher.js';

/**
 * Unit coverage for the dispatcher methods wired to the `gezel.fs.*`,
 * `gezel.memory.*`, and `gezel.task.*` SDK surface. These guard against
 * the SDK/runtime drift that previously left memory and several task/fs
 * methods declared-but-unhandled: each test asserts the RPC method both
 * forwards to the right service call and is gated by the right capability.
 */

function ctx(caps: ScriptCapability[], projectId = 'p1'): DispatcherContext {
  return {
    projectId,
    runId: 'run-1',
    scriptName: 'test-script',
    engagementFlags: { llmAllowed: true },
    allowedCapabilities: new Set(caps),
    knownSecretValues: new Set(),
  };
}

function makeDispatcher(deps: Partial<DispatcherDeps>) {
  return buildDispatcher({
    store: {} as Store,
    chat: {} as ChatManager,
    ...deps,
  });
}

describe('dispatcher: fs mutations', () => {
  it('fs.rm forwards to store.rmProjectWorkspacePath under workspace.write', async () => {
    const rmProjectWorkspacePath = vi.fn().mockResolvedValue(undefined);
    const { dispatch } = makeDispatcher({ store: { rmProjectWorkspacePath } as unknown as Store });
    await dispatch(ctx(['workspace.write']), 'fs.rm', { path: 'a/b.txt' });
    expect(rmProjectWorkspacePath).toHaveBeenCalledWith('p1', 'a/b.txt');
  });

  it('fs.mkdir forwards to store.mkdirProjectWorkspace', async () => {
    const mkdirProjectWorkspace = vi.fn().mockResolvedValue(undefined);
    const { dispatch } = makeDispatcher({ store: { mkdirProjectWorkspace } as unknown as Store });
    await dispatch(ctx(['workspace.write']), 'fs.mkdir', { path: 'out' });
    expect(mkdirProjectWorkspace).toHaveBeenCalledWith('p1', 'out');
  });

  it('fs.rename forwards from/to to store.renameProjectWorkspacePath', async () => {
    const renameProjectWorkspacePath = vi.fn().mockResolvedValue(undefined);
    const { dispatch } = makeDispatcher({
      store: { renameProjectWorkspacePath } as unknown as Store,
    });
    await dispatch(ctx(['workspace.write']), 'fs.rename', { from: 'a.txt', to: 'b.txt' });
    expect(renameProjectWorkspacePath).toHaveBeenCalledWith('p1', 'a.txt', 'b.txt');
  });

  it('fs.rm without workspace.write is denied', async () => {
    const { dispatch } = makeDispatcher({
      store: { rmProjectWorkspacePath: vi.fn() } as unknown as Store,
    });
    await expect(dispatch(ctx([]), 'fs.rm', { path: 'a' })).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });
});

describe('dispatcher: anonymous HTTP', () => {
  it('http.request fetches without credentials and does not follow redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-test': 'yes' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { dispatch } = makeDispatcher({});
      const out = await dispatch(ctx(['network']), 'http.request', {
        url: 'https://api.github.test/repos/o/r/issues',
        headers: { Accept: 'application/json' },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.test/repos/o/r/issues',
        expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'application/json' },
        }),
      );
      expect(out).toEqual({
        status: 200,
        ok: true,
        headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-test': 'yes' },
        body: '{"ok":true}',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('http.request rejects Authorization headers', async () => {
    const { dispatch } = makeDispatcher({});
    await expect(
      dispatch(ctx(['network']), 'http.request', {
        url: 'https://api.github.test',
        headers: { Authorization: 'Bearer nope' },
      }),
    ).rejects.toThrow(/anonymous/);
  });

  it('http.request is denied without the network capability', async () => {
    const { dispatch } = makeDispatcher({});
    await expect(
      dispatch(ctx([]), 'http.request', { url: 'https://api.github.test' }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it('http.request rejects loopback and private destinations before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { dispatch } = makeDispatcher({});
      await expect(
        dispatch(ctx(['network']), 'http.request', { url: 'http://127.0.0.1:8080/private' }),
      ).rejects.toThrow(/private or loopback/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('http.request rejects oversized response bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { dispatch } = makeDispatcher({});
      await expect(
        dispatch(ctx(['network']), 'http.request', { url: 'https://api.github.test/large' }),
      ).rejects.toThrow(/exceeded 1000000 bytes/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('dispatcher: authenticated HTTP', () => {
  it('rejects an unbound origin before resolving the credential', async () => {
    const resolve = vi.fn();
    const getProject = vi.fn().mockResolvedValue({ id: 'p1' });
    const { dispatch } = makeDispatcher({
      store: { getProject } as unknown as Store,
      credentials: { resolve } as unknown as DispatcherDeps['credentials'],
    });
    await expect(
      dispatch(ctx(['network', 'credential:github.token']), 'http.authed', {
        url: 'https://attacker.example/collect',
        credential: 'github.token',
      }),
    ).rejects.toThrow(/not allowed for origin/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows an explicitly configured public HTTPS origin and attaches the secret', async () => {
    const resolve = vi.fn().mockResolvedValue('secret-value');
    const getProject = vi.fn().mockResolvedValue({
      id: 'p1',
      credentialAllowedOrigins: { 'custom.key': ['https://api.vendor.test'] },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const runCtx = ctx(['network', 'credential:custom.key']);
      const { dispatch } = makeDispatcher({
        store: { getProject } as unknown as Store,
        credentials: { resolve } as unknown as DispatcherDeps['credentials'],
      });
      await dispatch(runCtx, 'http.authed', {
        url: 'https://api.vendor.test/v1/items',
        credential: 'custom.key',
      });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.vendor.test/v1/items',
        expect.objectContaining({
          redirect: 'manual',
          headers: { Authorization: 'Bearer secret-value' },
        }),
      );
      expect(runCtx.knownSecretValues).toContain('secret-value');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows an explicitly configured private HTTPS origin for self-hosted services', async () => {
    const resolve = vi.fn().mockResolvedValue('lan-secret');
    const getProject = vi.fn().mockResolvedValue({
      id: 'p1',
      credentialAllowedOrigins: { 'custom.key': ['https://127.0.0.1:8443'] },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { dispatch } = makeDispatcher({
        store: { getProject } as unknown as Store,
        credentials: { resolve } as unknown as DispatcherDeps['credentials'],
      });
      await dispatch(ctx(['network', 'credential:custom.key']), 'http.authed', {
        url: 'https://127.0.0.1:8443/collect',
        credential: 'custom.key',
      });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://127.0.0.1:8443/collect',
        expect.objectContaining({ headers: { Authorization: 'Bearer lan-secret' } }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores project origin overrides for built-in provider credentials', async () => {
    const resolve = vi.fn();
    const getProject = vi.fn().mockResolvedValue({
      id: 'p1',
      credentialAllowedOrigins: { 'github.token': ['https://github-proxy.example'] },
    });
    const { dispatch } = makeDispatcher({
      store: { getProject } as unknown as Store,
      credentials: { resolve } as unknown as DispatcherDeps['credentials'],
    });
    await expect(
      dispatch(ctx(['network', 'credential:github.token']), 'http.authed', {
        url: 'https://github-proxy.example/user',
        credential: 'github.token',
      }),
    ).rejects.toThrow(/not allowed for origin/);
    expect(resolve).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });
});

describe('dispatcher: memory', () => {
  it('memory.search forwards the project-scoped query', async () => {
    const search = vi.fn().mockResolvedValue([{ text: 'hit', score: 0.9 }]);
    const { dispatch } = makeDispatcher({ memory: { search } as unknown as MemoryManager });
    const out = await dispatch(ctx(['memory.read']), 'memory.search', { query: 'auth' });
    expect(search).toHaveBeenCalledWith('project', 'p1', 'auth');
    expect(out).toEqual([{ text: 'hit', score: 0.9 }]);
  });

  it('memory.save passes a valid kind from meta and defaults otherwise', async () => {
    const save = vi.fn().mockResolvedValue({ status: 'saved' });
    const { dispatch } = makeDispatcher({ memory: { save } as unknown as MemoryManager });
    await dispatch(ctx(['memory.write']), 'memory.save', { text: 'x', meta: { kind: 'pref' } });
    expect(save).toHaveBeenCalledWith('project', 'p1', 'x', 'pref');

    save.mockClear();
    await dispatch(ctx(['memory.write']), 'memory.save', { text: 'y', meta: { kind: 'bogus' } });
    expect(save).toHaveBeenCalledWith('project', 'p1', 'y', undefined);
  });

  it('memory.search is denied without memory.read', async () => {
    const { dispatch } = makeDispatcher({
      memory: { search: vi.fn() } as unknown as MemoryManager,
    });
    await expect(dispatch(ctx([]), 'memory.search', { query: 'x' })).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it('memory.save errors clearly when no memory manager is wired', async () => {
    const { dispatch } = makeDispatcher({});
    await expect(dispatch(ctx(['memory.write']), 'memory.save', { text: 'x' })).rejects.toThrow(
      /no memory manager wired/,
    );
  });
});

describe('dispatcher: task mutations', () => {
  it('task.update forwards the patch under tasks.write', async () => {
    const update = vi.fn().mockResolvedValue({ num: 7 });
    const { dispatch } = makeDispatcher({ tasks: { update } as unknown as TaskManager });
    await dispatch(ctx(['tasks.write']), 'task.update', { ref: '7', patch: { title: 'New' } });
    expect(update).toHaveBeenCalledWith('p1', 7, { title: 'New' });
  });

  it('task.update resolves a cross-project ref', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { dispatch } = makeDispatcher({ tasks: { update } as unknown as TaskManager });
    await dispatch(ctx(['tasks.write']), 'task.update', { ref: 'other/3', patch: {} });
    expect(update).toHaveBeenCalledWith('other', 3, {});
  });

  it('task.advance completes the active step via completeStepChecked', async () => {
    const readTask = vi.fn().mockResolvedValue({ activeStepId: 'step-2' });
    const completeStepChecked = vi.fn().mockResolvedValue({ status: 'advanced' });
    const { dispatch } = makeDispatcher({
      store: { readTask } as unknown as Store,
      tasks: { completeStepChecked } as unknown as TaskManager,
    });
    const out = await dispatch(ctx(['tasks.write']), 'task.advance', {
      ref: '7',
      nextPhaseName: 'review',
    });
    expect(completeStepChecked).toHaveBeenCalledWith('p1', 7, 'step-2', 'review');
    expect(out).toEqual({ status: 'advanced' });
  });

  it('task.advance throws when the task has no active step', async () => {
    const readTask = vi.fn().mockResolvedValue({ activeStepId: undefined });
    const { dispatch } = makeDispatcher({
      store: { readTask } as unknown as Store,
      tasks: { completeStepChecked: vi.fn() } as unknown as TaskManager,
    });
    await expect(dispatch(ctx(['tasks.write']), 'task.advance', { ref: '7' })).rejects.toThrow(
      /no active step/,
    );
  });

  it('task.create forwards the request to tasks.create', async () => {
    const create = vi.fn().mockResolvedValue({ num: 9 });
    const { dispatch } = makeDispatcher({ tasks: { create } as unknown as TaskManager });
    const req = { title: 'T', description: 'd'.repeat(40) };
    await dispatch(ctx(['tasks.write']), 'task.create', { req });
    expect(create).toHaveBeenCalledWith('p1', req);
  });

  it('task.writeNotes appends a note with phaseId mapped to stepId', async () => {
    const appendTaskNote = vi.fn().mockResolvedValue(undefined);
    const { dispatch } = makeDispatcher({ store: { appendTaskNote } as unknown as Store });
    await dispatch(ctx(['tasks.write']), 'task.writeNotes', {
      ref: '7',
      content: 'a note',
      phaseId: 'step-1',
    });
    expect(appendTaskNote).toHaveBeenCalledTimes(1);
    const [pid, num, note] = appendTaskNote.mock.calls[0] ?? [];
    expect(pid).toBe('p1');
    expect(num).toBe(7);
    expect(note).toMatchObject({ text: 'a note', stepId: 'step-1', author: { kind: 'user' } });
  });

  it('task.appendNote returns the created note with stepId attached', async () => {
    const appendTaskNote = vi.fn().mockResolvedValue(undefined);
    const { dispatch } = makeDispatcher({ store: { appendTaskNote } as unknown as Store });
    const note = (await dispatch(ctx(['tasks.write']), 'task.appendNote', {
      ref: '7',
      text: 'a note',
      stepId: 'step-1',
    })) as Record<string, unknown>;
    expect(note).toMatchObject({ text: 'a note', stepId: 'step-1', author: { kind: 'user' } });
    expect(typeof note.id).toBe('string');
    expect(typeof note.at).toBe('string');
    const [pid, num, written] = appendTaskNote.mock.calls[0] ?? [];
    expect(pid).toBe('p1');
    expect(num).toBe(7);
    expect(written).toEqual(note);
  });

  it('task.deleteNote forwards to store.deleteTaskNote', async () => {
    const deleteTaskNote = vi.fn().mockResolvedValue({ id: 'n1', text: 'gone' });
    const { dispatch } = makeDispatcher({ store: { deleteTaskNote } as unknown as Store });
    const out = await dispatch(ctx(['tasks.write']), 'task.deleteNote', { ref: '7', noteId: 'n1' });
    expect(deleteTaskNote).toHaveBeenCalledWith('p1', 7, 'n1');
    expect(out).toEqual({ id: 'n1', text: 'gone' });
  });

  it('task.listNotes is no longer a registered method', async () => {
    const { dispatch } = makeDispatcher({ store: { listTaskNotes: vi.fn() } as unknown as Store });
    await expect(dispatch(ctx(['tasks.read']), 'task.listNotes', { ref: '7' })).rejects.toThrow(
      /unknown method/,
    );
  });

  it('task.readNotes joins note bodies with blank lines', async () => {
    const listTaskNotes = vi.fn().mockResolvedValue([{ text: 'one' }, { text: 'two' }]);
    const { dispatch } = makeDispatcher({ store: { listTaskNotes } as unknown as Store });
    const out = await dispatch(ctx(['tasks.read']), 'task.readNotes', { ref: '7' });
    expect(listTaskNotes).toHaveBeenCalledWith('p1', 7, undefined);
    expect(out).toBe('one\n\ntwo');
  });

  it('task.steps returns curated steps with a derived status', async () => {
    const readTask = vi.fn().mockResolvedValue({
      activeStepId: 'b',
      craftbook: {
        steps: [
          { id: 'a', name: 'First', completedAt: '2026-01-01T00:00:00Z', attemptCount: 1 },
          { id: 'b', name: 'Second', description: 'do it', attemptCount: 2 },
          { id: 'c', name: 'Third', terminal: true },
        ],
      },
    });
    const { dispatch } = makeDispatcher({ store: { readTask } as unknown as Store });
    const steps = (await dispatch(ctx(['tasks.read']), 'task.steps', { ref: '7' })) as Array<
      Record<string, unknown>
    >;
    expect(steps).toEqual([
      {
        id: 'a',
        name: 'First',
        status: 'complete',
        isActive: false,
        completedAt: '2026-01-01T00:00:00Z',
        attemptCount: 1,
      },
      {
        id: 'b',
        name: 'Second',
        description: 'do it',
        status: 'active',
        isActive: true,
        attemptCount: 2,
      },
      { id: 'c', name: 'Third', status: 'pending', isActive: false, terminal: true },
    ]);
  });

  it('task.currentStep returns the active step', async () => {
    const readTask = vi.fn().mockResolvedValue({
      activeStepId: 'b',
      craftbook: {
        steps: [
          { id: 'a', name: 'First' },
          { id: 'b', name: 'Second' },
        ],
      },
    });
    const { dispatch } = makeDispatcher({ store: { readTask } as unknown as Store });
    const step = (await dispatch(ctx(['tasks.read']), 'task.currentStep', { ref: '7' })) as Record<
      string,
      unknown
    >;
    expect(step).toMatchObject({ id: 'b', name: 'Second', status: 'active', isActive: true });
  });

  it('task.currentStep returns null when no step is active', async () => {
    const readTask = vi.fn().mockResolvedValue({
      activeStepId: undefined,
      craftbook: { steps: [{ id: 'a', name: 'First' }] },
    });
    const { dispatch } = makeDispatcher({ store: { readTask } as unknown as Store });
    const step = await dispatch(ctx(['tasks.read']), 'task.currentStep', { ref: '7' });
    expect(step).toBeNull();
  });

  it('task.update errors clearly when no task manager is wired', async () => {
    const { dispatch } = makeDispatcher({});
    await expect(
      dispatch(ctx(['tasks.write']), 'task.update', { ref: '1', patch: {} }),
    ).rejects.toThrow(/no task manager wired/);
  });
});
