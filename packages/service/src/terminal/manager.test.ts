import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalEventEnvelope, WorkspaceCommandIndex } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import { TerminalEventBus } from './events.js';
import { type CraftbookInvoker, TerminalManager } from './manager.js';
import type { CraftbookCommandSpec } from './resolve.js';

const bashAvailable = process.platform !== 'win32' && existsSync('/bin/bash');
const itPosix = bashAvailable ? it : it.skip;

let home: string;
let store: Store;
let events: TerminalEventBus;
let activeManager: TerminalManager | null = null;

/**
 * Stub WorkspaceIndexManager: only `readCommandIndex` is used by the
 * TerminalManager. Cast through unknown so we can satisfy the type
 * without standing up the full manager (which would require a
 * ChatManager + Store + tick scheduler — none of which this test
 * needs).
 */
function stubIndex(index: WorkspaceCommandIndex | null): WorkspaceIndexManager {
  return {
    readCommandIndex: async () => index,
  } as unknown as WorkspaceIndexManager;
}

function makeManager(opts: {
  workspaceIndex: WorkspaceIndexManager;
  listCraftbookCommands?: (projectId: string) => Promise<CraftbookCommandSpec[]>;
  craftbookInvoker?: CraftbookInvoker;
}): TerminalManager {
  const mgr = new TerminalManager({
    store,
    workspaceIndex: opts.workspaceIndex,
    events,
    ...(opts.listCraftbookCommands ? { listCraftbookCommands: opts.listCraftbookCommands } : {}),
    ...(opts.craftbookInvoker ? { craftbookInvoker: opts.craftbookInvoker } : {}),
  });
  activeManager = mgr;
  return mgr;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-terminal-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  events = new TerminalEventBus();
  await store.createProject({ name: 'proj', description: '' });
});

afterEach(async () => {
  // Kill any spawned shells before nuking $HOME so they don't keep
  // running with paths pointed at deleted dirs.
  if (activeManager) {
    await activeManager.shutdown();
    activeManager = null;
  }
  await rm(home, { recursive: true, force: true });
});

describe('TerminalManager', () => {
  itPosix('round-trips a command through the persistent shell and persists output', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const collected: TerminalEventEnvelope[] = [];
    events.subscribeProject(projectId, (env) => collected.push(env));

    const mgr = makeManager({ workspaceIndex: stubIndex(null) });

    const outcome = await mgr.enqueueRun(projectId, '', 'echo hi-from-shell');
    expect(outcome.resolution.kind).toBe('argv');

    // Drain the per-thread queue.
    await new Promise((r) => setTimeout(r, 1500));

    const thread = await store.getTerminalThread(projectId, outcome.threadId);
    expect(thread).not.toBeNull();
    expect(thread!.messages).toHaveLength(2);
    const [cmd, out] = thread!.messages;
    expect(cmd!.kind).toBe('command');
    expect(out!.kind).toBe('output');
    expect(out!.exitCode).toBe(0);
    expect(out!.content).toContain('hi-from-shell');

    // Filter by `kind === 'message'` since the envelope union now
    // also includes `workingDirChanged` for shell cwd drift.
    const messages = collected.flatMap((e) => (e.kind === 'message' ? [e.message] : []));
    expect(messages).toHaveLength(2);
    expect(messages[0]!.kind).toBe('command');
    expect(messages[1]!.kind).toBe('output');
  });

  itPosix(
    'attaches per-message cwd so the next command bubble shows the shell-relative folder',
    async () => {
      // Setup: project workspace with a subdir, two commands that
      // straddle a cd. The first command's bubble shows the thread
      // anchor (''); the cd's output bubble lands at 'inner'; the
      // subsequent command's bubble shows 'inner' (the shell has
      // moved, even though the thread anchor is still '').
      const projectId = (await store.listProjects())[0]!.id;
      const wsRoot = await store.projectWorkspaceDir(projectId);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(wsRoot, 'inner'), { recursive: true });

      const mgr = makeManager({ workspaceIndex: stubIndex(null) });

      await mgr.enqueueRun(projectId, '', 'pwd');
      await new Promise((r) => setTimeout(r, 1500));
      await mgr.enqueueRun(projectId, '', 'cd inner');
      await new Promise((r) => setTimeout(r, 1500));
      await mgr.enqueueRun(projectId, '', 'pwd');
      await new Promise((r) => setTimeout(r, 1500));

      const threadId = mgr.threadIdFor('');
      const thread = await store.getTerminalThread(projectId, threadId);
      expect(thread).not.toBeNull();
      // Three commands × 2 bubbles each.
      expect(thread!.messages).toHaveLength(6);
      const commands = thread!.messages.filter((m) => m.kind === 'command');
      expect(commands).toHaveLength(3);
      // First `pwd`: bubble cwd = '' (thread anchor, shell at root).
      expect(commands[0]!.cwd).toBe('');
      // `cd inner`: bubble cwd = '' (still at root before the cd runs).
      expect(commands[1]!.cwd).toBe('');
      // Second `pwd`: bubble cwd = 'inner' (shell has drifted).
      expect(commands[2]!.cwd).toBe('inner');
    },
  );

  itPosix(
    'publishes runStarted + outputChunk + final message events for a streaming run',
    async () => {
      const projectId = (await store.listProjects())[0]!.id;
      const collected: TerminalEventEnvelope[] = [];
      events.subscribeProject(projectId, (env) => collected.push(env));

      const mgr = makeManager({ workspaceIndex: stubIndex(null) });

      // Three echoes with sleeps guarantee distinct PTY data events.
      const outcome = await mgr.enqueueRun(
        projectId,
        '',
        'echo c1; sleep 0.1; echo c2; sleep 0.1; echo c3',
      );
      expect(outcome.resolution.kind).toBe('argv');
      await new Promise((r) => setTimeout(r, 2500));

      const kinds = collected.map((e) => e.kind);
      // Exact order: command message, runStarted, one-or-more
      // outputChunk events, final output message. The `runId`
      // ties runStarted/outputChunk/final message together.
      expect(kinds[0]).toBe('message'); // command bubble
      expect(kinds[1]).toBe('runStarted');
      expect(kinds).toContain('outputChunk');
      // Last event is the final output message tagged with runId.
      const lastMessage = collected.flatMap((e) => (e.kind === 'message' ? [e] : [])).at(-1);
      expect(lastMessage).toBeDefined();
      expect(lastMessage?.runId).toBe(outcome.runId);
      expect(lastMessage?.message.kind).toBe('output');
      expect(lastMessage?.message.content).toContain('c1');
      expect(lastMessage?.message.content).toContain('c3');

      // Joined chunks should also include the output.
      const chunks = collected.flatMap((e) => (e.kind === 'outputChunk' ? [e.chunk] : [])).join('');
      expect(chunks).toContain('c1');
      expect(chunks).toContain('c3');
    },
  );

  it('shows an immediate "Creating task" live bubble before the craftbook result', async () => {
    // No shell involved — the craftbook path dispatches to the invoker,
    // so this runs on every platform (unlike the argv shell tests).
    const projectId = (await store.listProjects())[0]!.id;
    const collected: TerminalEventEnvelope[] = [];
    events.subscribeProject(projectId, (env) => collected.push(env));

    const mgr = makeManager({
      workspaceIndex: stubIndex(null),
      listCraftbookCommands: async () => [{ id: 'demo-book', command: 'demo-book' }],
      craftbookInvoker: async () => ({
        taskRef: `${projectId}/5`,
        craftbookName: 'Demo',
        assigneeName: 'Rosalind',
        started: true,
      }),
    });

    const outcome = await mgr.enqueueRun(projectId, '', 'demo-book');
    expect(outcome.resolution.kind).toBe('craftbook');

    // Let the per-thread queue drain the invocation.
    await new Promise((r) => setTimeout(r, 100));

    // Command echo, then the immediate live bubble (runStarted + a
    // progress chunk), then the final result — in that exact order.
    expect(collected.map((e) => e.kind)).toEqual([
      'message',
      'runStarted',
      'outputChunk',
      'message',
    ]);

    const chunk = collected.find((e) => e.kind === 'outputChunk');
    expect(chunk?.kind === 'outputChunk' ? chunk.chunk : '').toContain('Creating task');

    // The final result carries the same runId as the runStarted, so the
    // client releases the live slot and the result takes over the row.
    const started = collected.find((e) => e.kind === 'runStarted');
    const finalMsg = collected.filter((e) => e.kind === 'message').at(-1);
    const startedRunId = started?.kind === 'runStarted' ? started.runId : 'started';
    const finalRunId = finalMsg?.kind === 'message' ? finalMsg.runId : 'final';
    expect(finalRunId).toBe(outcome.runId);
    expect(finalRunId).toBe(startedRunId);
    expect(finalMsg?.kind === 'message' ? finalMsg.message.content : '').toContain(
      'Task 5 (demo-book) has been launched and assigned to Rosalind.',
    );
  });

  itPosix('cancelRun sends Ctrl+C to the in-flight run; shell survives', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const mgr = makeManager({ workspaceIndex: stubIndex(null) });

    // Start a long-running sleep so we have a window to cancel.
    const outcome = await mgr.enqueueRun(projectId, '', 'sleep 30');
    expect(outcome.resolution.kind).toBe('argv');

    // Give the manager a tick to register the run in
    // activeRunThreads, then cancel.
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.cancelRun(outcome.runId)).toBe(true);

    // Wait for the cancelled run's output bubble to land.
    await new Promise((r) => setTimeout(r, 1500));
    const thread = await store.getTerminalThread(projectId, outcome.threadId);
    const output = thread!.messages.find((m) => m.kind === 'output');
    expect(output).toBeDefined();
    expect(output!.exitCode).not.toBe(0);

    // Cancelling a completed run is a no-op (returns false).
    expect(mgr.cancelRun(outcome.runId)).toBe(false);

    // Shell still alive — next command works.
    const next = await mgr.enqueueRun(projectId, '', 'echo still-alive');
    expect(next.resolution.kind).toBe('argv');
    await new Promise((r) => setTimeout(r, 1500));
    const nextThread = await store.getTerminalThread(projectId, next.threadId);
    expect(nextThread!.messages.at(-1)?.content).toContain('still-alive');
  });

  itPosix(
    'detects an interactive prompt, publishes inputRequested, accepts sendInput',
    async () => {
      const projectId = (await store.listProjects())[0]!.id;
      const collected: TerminalEventEnvelope[] = [];
      events.subscribeProject(projectId, (env) => collected.push(env));

      const mgr = makeManager({ workspaceIndex: stubIndex(null) });

      // `read -p` blocks waiting for stdin. The detector should
      // fire after ~600ms of silence on the prompt line. We use
      // two separate enqueueRun calls (instead of chaining with
      // `&&`) because the resolver quotes argv tokens and would
      // otherwise turn `&&` into a literal arg to `read`.
      const r1 = await mgr.enqueueRun(projectId, '', 'read -p "name? " name');
      expect(r1.resolution.kind).toBe('argv');
      await new Promise((r) => setTimeout(r, 1000));

      const inputRequested = collected.flatMap((e) => (e.kind === 'inputRequested' ? [e] : []));
      expect(inputRequested.length).toBeGreaterThanOrEqual(1);
      expect(inputRequested[0]!.mode).toBe('text');
      expect(inputRequested[0]!.runId).toBe(r1.runId);

      // Feed input via the manager — `read` unblocks, the run
      // resolves. The persistent-shell test already proves the
      // typed bytes reach the command's stdin; here we just need
      // the run to complete cleanly and the final message event
      // to fire (proving the manager's sendInput plumbing works
      // end-to-end through the pool + shell).
      expect(mgr.sendInput(r1.runId, 'Mike')).toBe(true);
      await new Promise((r) => setTimeout(r, 1500));
      const finalMessage = collected
        .flatMap((e) => (e.kind === 'message' && e.runId === r1.runId ? [e] : []))
        .at(-1);
      expect(finalMessage).toBeDefined();
      expect(finalMessage!.message.exitCode).toBe(0);

      // sendInput on a completed run should return false.
      expect(mgr.sendInput(r1.runId, 'late')).toBe(false);
    },
  );

  itPosix('emits workingDirChanged when the user cd-s inside the shell', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const collected: TerminalEventEnvelope[] = [];
    events.subscribeProject(projectId, (env) => collected.push(env));

    // Materialize a subdir inside the project workspace so the cd
    // resolves and the shell's pwd lands somewhere meaningful.
    const wsRoot = await store.projectWorkspaceDir(projectId);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(wsRoot, 'inner'), { recursive: true });

    const mgr = makeManager({ workspaceIndex: stubIndex(null) });

    await mgr.enqueueRun(projectId, '', 'cd inner');
    await new Promise((r) => setTimeout(r, 1500));

    let drift = collected.flatMap((e) => (e.kind === 'workingDirChanged' ? [e] : []));
    expect(drift).toHaveLength(1);
    expect(drift[0]!.newWorkingDir).toBe('inner');

    // `cd ..` back to root MUST also fire a workingDirChanged event.
    // The comparison is against the pre-run cwd, not the thread
    // anchor — otherwise both old and new display dirs would be
    // `''` and the event would silently skip, stranding the
    // folder picker on `inner`.
    await mgr.enqueueRun(projectId, '', 'cd ..');
    await new Promise((r) => setTimeout(r, 1500));
    drift = collected.flatMap((e) => (e.kind === 'workingDirChanged' ? [e] : []));
    expect(drift).toHaveLength(2);
    expect(drift[1]!.newWorkingDir).toBe('');
  });

  itPosix('resolves typed names through the workspace index', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const mgr = makeManager({
      workspaceIndex: stubIndex({
        meta: {
          version: 2,
          scannedAt: new Date().toISOString(),
          root: '/tmp',
          durationMs: 0,
          fileCount: 0,
          commandCount: 1,
        },
        commands: [
          {
            name: 'hello',
            kind: 'npm-script',
            source: 'package.json',
            run: `${process.execPath} -e "console.log('aliased')"`,
          },
        ],
      }),
    });

    const outcome = await mgr.enqueueRun(projectId, '', 'hello');
    expect(outcome.resolution.kind).toBe('argv');
    if (outcome.resolution.kind === 'argv') {
      expect(outcome.resolution.resolvedFrom).toBe('hello');
    }

    await new Promise((r) => setTimeout(r, 1500));
    const thread = await store.getTerminalThread(projectId, outcome.threadId);
    expect(thread!.messages.at(-1)?.content).toContain('aliased');
  });

  it('intercepts pwd without spawning', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const mgr = makeManager({ workspaceIndex: stubIndex(null) });

    const outcome = await mgr.enqueueRun(projectId, 'packages/ui', 'pwd');
    expect(outcome.resolution.kind).toBe('intercept');

    // Intercepts persist synchronously inside enqueueRun — no need to wait.
    const thread = await store.getTerminalThread(projectId, outcome.threadId);
    expect(thread!.messages).toHaveLength(2);
    expect(thread!.messages[1]!.content).toBe('packages/ui');
  });

  it('rejects empty input and parse errors without persisting anything', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const mgr = makeManager({ workspaceIndex: stubIndex(null) });

    const empty = await mgr.enqueueRun(projectId, '', '   ');
    expect(empty.resolution.kind).toBe('empty');

    const parseErr = await mgr.enqueueRun(projectId, '', `echo "oops`);
    expect(parseErr.resolution.kind).toBe('parseError');

    const threads = await store.listTerminalThreads(projectId);
    expect(threads).toEqual([]);
  });

  it('threads commands per workingDir', async () => {
    const projectId = (await store.listProjects())[0]!.id;
    const mgr = makeManager({ workspaceIndex: stubIndex(null) });

    await mgr.enqueueRun(projectId, '', 'pwd');
    await mgr.enqueueRun(projectId, 'packages/ui', 'pwd');
    await mgr.enqueueRun(projectId, '', 'pwd');

    const threads = await store.listTerminalThreads(projectId);
    expect(threads).toHaveLength(2);
    const root = threads.find((t) => t.workingDir === '');
    const sub = threads.find((t) => t.workingDir === 'packages/ui');
    expect(root).toBeDefined();
    expect(sub).toBeDefined();
  });
});
