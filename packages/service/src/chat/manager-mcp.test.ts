import { mkdtemp, readFile, rm } from 'node:fs/promises';
/**
 * ChatManager + MCP tool-call coverage. Uses the MockProvider's
 * `scriptToolCalls` hook so a session-level send() triggers real MCP bridge
 * invocations against the live @bendyline/gezel-mcp server. Proves that
 * session opts propagate the MCP spec into the provider correctly and that
 * tools can read from / write to the gezel home.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question, Task } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const require = createRequire(import.meta.url);

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let svc: RunningService;
let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;

/**
 * These deliberately small guardrail-shaped scripts own the runtime seam,
 * not the catalog wording. The catalog tests pin the production Careful and
 * Freeze sources; this test pins that required hook metadata survives the
 * active-task snapshot and reaches a real inline ScriptRunner invocation.
 */
const CAREFUL_HOOK_SOURCE = `
  import { defineScript, gezel } from '@bendyline/gezel-sdk';

  export const meta = defineScript({
    name: 'check-careful',
    description: 'Ask before the protected delete used by the hook integration test.',
    inputs: {
      toolName: { type: 'string', description: 'Matched MCP tool name.', required: true },
      args: { type: 'json', description: 'Tool arguments.', required: true },
      phase: { type: 'string', description: 'Hook phase.', required: true },
    },
    outputs: {
      decision: { type: 'string', description: 'allow | ask' },
      message: { type: 'string', description: 'Approval reason.' },
    },
  });

  const input = gezel.input as {
    toolName: string;
    args: Record<string, unknown>;
    phase: string;
  };
  const protectedDelete =
    input.phase === 'PreToolUse' &&
    input.toolName === 'delete_path' &&
    input.args.path === 'protected.txt';
  gezel.output(
    protectedDelete
      ? { decision: 'ask', message: 'careful integration: approve protected delete' }
      : { decision: 'allow', message: '' },
  );
`;

const FREEZE_HOOK_SOURCE = `
  import { defineScript, gezel } from '@bendyline/gezel-sdk';

  export const meta = defineScript({
    name: 'check-freeze',
    description: 'Deny writes outside the seeded freeze boundary.',
    inputs: {
      toolName: { type: 'string', description: 'Matched MCP tool name.', required: true },
      args: { type: 'json', description: 'Tool arguments.', required: true },
      phase: { type: 'string', description: 'Hook phase.', required: true },
    },
    outputs: {
      decision: { type: 'string', description: 'allow | deny' },
      message: { type: 'string', description: 'Boundary reason.' },
    },
    requires: ['workspace.read'],
  });

  const input = gezel.input as {
    toolName: string;
    args: Record<string, unknown>;
    phase: string;
  };
  const state = JSON.parse(await gezel.fs.read('.gezel/freeze.json')) as { dir?: string };
  const path = String(input.args.path ?? '');
  const dir = String(state.dir ?? '');
  const inside = path === dir || path.startsWith(dir + '/');
  const checkedWrite = input.phase === 'PreToolUse' && input.toolName === 'write_file';
  gezel.output(
    checkedWrite && !inside
      ? { decision: 'deny', message: 'freeze integration: outside write denied' }
      : { decision: 'allow', message: '' },
  );
`;

async function installInlineHookTask(input: {
  craftbookId: string;
  craftbookName: string;
  matcher: string;
  scriptName: string;
  source: string;
}): Promise<Task> {
  const task = await svc.context.tasks.create('default', {
    title: `${input.craftbookName} integration`,
    assignee: { kind: 'gezel', gezelId: 'ada' },
    steps: [{ name: 'Guard active', prompt: 'Exercise the active guardrail hook.' }],
  });
  const now = new Date().toISOString();
  const updated: Task = {
    ...task,
    craftbook: {
      ...task.craftbook,
      id: input.craftbookId,
      name: input.craftbookName,
      hooks: [
        {
          phase: 'PreToolUse',
          matcher: input.matcher,
          script: { name: input.scriptName, scope: 'craftbook' },
          label: `${input.craftbookId} integration hook`,
        },
      ],
      scripts: { [input.scriptName]: input.source },
      updatedAt: now,
    },
    updatedAt: now,
  };
  await store.writeTask(updated);
  return updated;
}

async function waitForToolPermissionQuestion(timeoutMs = 5_000): Promise<Question> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const question = (await store.listProjectQuestions('default')).find(
      (candidate) => candidate.intent?.kind === 'tool-permission' && !candidate.answer,
    );
    if (question) return question;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the Careful hook permission question');
}

beforeEach(async () => {
  // Boot a live service because the MCP tools call back into /api/...
  // Flag suppresses the background system-toolsets bootstrap — otherwise
  // its tarball download races with `afterEach`'s home rm and throws.
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-mcp-test-'));
  svc = await startService({ home });
  store = svc.context.store;
  // Replace the running manager's provider cache with our mock instance
  // so we can script tool calls on it directly.
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => svc.port,
    getToken: () => svc.context.token,
    // Spawned MCP children need to trust the daemon's per-launch HTTPS
    // cert. Re-using the running service's cert is the same plumbing
    // the production `service.ts` uses; without this the bridge tests
    // hit `fetch failed` on every memory/document call.
    getCert: () => svc.cert?.certPem ?? null,
    home,
    providers: [['copilot', mock]],
    catalog: svc.context.catalog,
    secrets: svc.context.secrets,
    history: svc.context.history,
  });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  // These tests exercise bridge plumbing — that a scripted tool call
  // actually fires through the MCP bridge — not role-based tool gating.
  // Disable the role filter so a Developer gezel can drive tools from the
  // documents / team-management / images groups (write_document,
  // create_gezel, generate_image) that the Developer role trims by default.
  // 'provider' pins the injected mock: without it, routing falls through to
  // the platform default (an on-device engine) and the mock is never reached.
  await store.writeConfig({ provider: 'copilot', toolFilterMode: 'never' });
}, 20_000);

afterEach(async () => {
  await manager?.drainBackground();
  await manager?.shutdown();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
});

describe.runIf(process.platform === 'darwin')(
  'ChatManager + MCP — inline craftbook guardrail hooks',
  () => {
    it('routes Careful required inputs through ScriptRunner and denies a declined delete', async () => {
      manager.setScriptRunner(svc.context.scriptRunner);
      await store.writeProjectWorkspaceFile('default', 'protected.txt', 'keep me\n');
      const task = await installInlineHookTask({
        craftbookId: 'careful-mode',
        craftbookName: 'Careful Mode',
        matcher: '^delete_path$',
        scriptName: 'check-careful',
        source: CAREFUL_HOOK_SOURCE,
      });
      const session = await manager.createSession({
        gezelId: 'ada',
        projectId: 'default',
        taskRef: task.ref,
        stepId: task.activeStepId,
      });

      mock.scriptToolCalls([{ name: 'delete_path', arguments: { path: 'protected.txt' } }]);
      mock.script('The delete was denied.');
      const send = manager.send(session.id, 'Delete protected.txt.');

      const question = await waitForToolPermissionQuestion();
      expect(question.intent).toMatchObject({
        kind: 'tool-permission',
        toolName: 'delete_path',
      });
      expect(question.prompt).toContain('careful integration: approve protected delete');
      await store.writeQuestion({
        ...question,
        answer: { selectedChoices: [1], at: new Date().toISOString() },
      });
      await send;

      await expect(store.readProjectWorkspaceFile('default', 'protected.txt')).resolves.toBe(
        'keep me\n',
      );
      expect(mock.toolCallOutputs.find(({ name }) => name === 'delete_path')?.output).toContain(
        'careful integration: approve protected delete',
      );
      const persisted = await store.getSession('ada', session.id);
      const reply = persisted?.messages.find(({ content }) => content === 'The delete was denied.');
      expect(reply?.toolCalls?.[0]).toMatchObject({ name: 'delete_path', success: false });

      const gated = await svc.context.history.listEvents({
        projectId: 'default',
        kinds: ['tool.gated'],
      });
      expect(gated).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            craftbookId: 'careful-mode',
            tool: 'delete_path',
            decision: 'ask',
          }),
        }),
      ]);
    }, 30_000);

    it('routes Freeze required inputs through ScriptRunner and denies an outside write', async () => {
      manager.setScriptRunner(svc.context.scriptRunner);
      await store.writeProjectWorkspaceFile('default', '.gezel/freeze.json', '{"dir":"safe"}\n');
      await store.writeProjectWorkspaceFile('default', 'outside.txt', 'original\n');
      const task = await installInlineHookTask({
        craftbookId: 'freeze-scope',
        craftbookName: 'Freeze Scope',
        matcher: '^write_file$',
        scriptName: 'check-freeze',
        source: FREEZE_HOOK_SOURCE,
      });
      const session = await manager.createSession({
        gezelId: 'ada',
        projectId: 'default',
        taskRef: task.ref,
        stepId: task.activeStepId,
      });

      mock.scriptToolCalls([
        {
          name: 'write_file',
          arguments: { path: 'outside.txt', content: 'changed\n' },
        },
      ]);
      mock.script('The outside write was denied.');
      await manager.send(session.id, 'Overwrite outside.txt.');

      await expect(store.readProjectWorkspaceFile('default', 'outside.txt')).resolves.toBe(
        'original\n',
      );
      expect(mock.toolCallOutputs.find(({ name }) => name === 'write_file')?.output).toContain(
        'freeze integration: outside write denied',
      );
      const persisted = await store.getSession('ada', session.id);
      const reply = persisted?.messages.find(
        ({ content }) => content === 'The outside write was denied.',
      );
      expect(reply?.toolCalls?.[0]).toMatchObject({ name: 'write_file', success: false });

      const gated = await svc.context.history.listEvents({
        projectId: 'default',
        kinds: ['tool.gated'],
      });
      expect(gated).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            craftbookId: 'freeze-scope',
            tool: 'write_file',
            decision: 'deny',
          }),
        }),
      ]);
    }, 30_000);
  },
);

describe('ChatManager + MCP — tool calls fire through the bridge', () => {
  it('executes a scripted write_document tool call during send()', async () => {
    // Sanity-check that the MCP server bundle exists.
    const mcpPath = require.resolve('@bendyline/gezel-mcp/dist/server.js');
    expect(mcpPath).toBeTruthy();

    const session = await manager.createSession({ gezelId: 'ada' });

    // Script the tool call + the text reply it precedes.
    mock.scriptToolCalls([
      {
        name: 'write_document',
        arguments: { path: 'from-mock/hello.md', content: '# Written via MCP\n' },
      },
    ]);
    mock.script('I wrote the doc.');

    await manager.send(session.id, 'please write a doc for me');

    // Verify the bridge actually invoked the tool.
    const names = mock.toolCallOutputs.map((o) => o.name);
    expect(names).toContain('write_document');

    // The doc should now be on disk under the service's home.
    const onDisk = await readFile(
      join(svc.context.home, 'documents', 'from-mock', 'hello.md'),
      'utf8',
    );
    expect(onDisk).toContain('Written via MCP');

    // And the assistant reply reached the persisted session.
    const disk = await store.getSession('ada', session.id);
    expect(disk?.messages.some((m) => m.content === 'I wrote the doc.')).toBe(true);

    // The tool call was captured onto the assistant message so the UI's
    // post-stream "thought process" expando has something to render.
    const assistantMsg = disk!.messages.find((m) => m.content === 'I wrote the doc.');
    expect(assistantMsg?.toolCalls).toBeTruthy();
    expect(assistantMsg!.toolCalls!.length).toBe(1);
    expect(assistantMsg!.toolCalls![0]!.name).toBe('write_document');
    expect(assistantMsg!.toolCalls![0]!.success).toBe(true);
    expect(assistantMsg!.toolCalls![0]!.resultText).toBeTruthy();
    expect(assistantMsg!.toolCalls![0]!.resultTruncated).not.toBe(true);
  }, 30_000);

  it('stamps each tool call with its offset into the turn reasoning trace', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptReasoning('I should write the doc. ', 'Then confirm it landed.');
    mock.scriptToolCalls([
      {
        name: 'write_document',
        arguments: { path: 'offsets/hello.md', content: '# Offsets\n' },
      },
    ]);
    mock.script('Written.');

    await manager.send(session.id, 'write a doc');

    const disk = await store.getSession('ada', session.id);
    const assistantMsg = disk!.messages.find((m) => m.content === 'Written.');
    const call = assistantMsg!.toolCalls![0]!;
    // The offset indexes the trace that was actually persisted — that
    // identity is the whole contract, since several providers build
    // `getLastTurnReasoning()` from `<think>` extraction rather than from
    // the delta stream the manager sees.
    expect(call.afterReasoningChars).toBe(assistantMsg!.reasoning!.length);
    expect(assistantMsg!.reasoning).toBe('I should write the doc. Then confirm it landed.');
  }, 30_000);

  it('can script create_gezel (meester-style) and the new gezel appears on disk', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'create_gezel',
        arguments: {
          role: 'Reviewer',
          about:
            '## Identity\n\nYou are a reviewer gezel. You read artifacts and ' +
            'give terse, actionable feedback. Prefer line-level comments ' +
            'over abstract praise or dismissal.\n',
        },
      },
    ]);
    mock.script('Created your Reviewer.');

    await manager.send(session.id, 'add a reviewer gezel');

    // The MCP `create_gezel` tool auto-assigns the name from a curated
    // pool; we only get to specify the role. Assert on role + count
    // instead of a hard-coded name.
    const gezels = await store.listGezels();
    const reviewers = gezels.filter((g) => g.role === 'Reviewer');
    expect(reviewers).toHaveLength(1);
    // The create_gezel tool output should reflect success.
    const createOutput = mock.toolCallOutputs.find((o) => o.name === 'create_gezel');
    expect(createOutput?.output).toMatch(/Created gezel/);
  }, 30_000);

  it('chains multiple tool calls before the reply', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      { name: 'write_document', arguments: { path: 'a.md', content: 'A' } },
      { name: 'write_document', arguments: { path: 'b.md', content: 'B' } },
      { name: 'list_documents', arguments: { recursive: true } },
    ]);
    mock.script('Done writing two docs.');

    await manager.send(session.id, 'create a.md and b.md');

    const names = mock.toolCallOutputs.map((o) => o.name);
    expect(names).toEqual(['write_document', 'write_document', 'list_documents']);

    // The list_documents output should mention both files.
    const listOutput = mock.toolCallOutputs.find((o) => o.name === 'list_documents')!.output;
    expect(listOutput).toContain('a.md');
    expect(listOutput).toContain('b.md');

    // All three tool calls end up on the assistant message so the post-
    // stream expando shows the full thought process, not just the reply.
    const disk = await store.getSession('ada', session.id);
    const assistantMsg = disk!.messages.find((m) => m.content === 'Done writing two docs.');
    expect(assistantMsg?.toolCalls?.map((t) => t.name)).toEqual([
      'write_document',
      'write_document',
      'list_documents',
    ]);
  }, 30_000);

  it('persists every successful path returned by read_files', async () => {
    await Promise.all([
      store.writeProjectWorkspaceFile('default', 'src/alpha.txt', 'alpha\n'),
      store.writeProjectWorkspaceFile('default', 'src/beta.txt', 'beta\n'),
    ]);
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.scriptToolCalls([
      {
        name: 'read_files',
        arguments: { paths: ['src/alpha.txt', 'src/beta.txt'] },
      },
    ]);
    mock.script('Compared both files.');

    await manager.send(session.id, 'compare the two files');

    const disk = await store.getSession('ada', session.id);
    const assistantMsg = disk?.messages.find(
      (message) => message.content === 'Compared both files.',
    );
    expect(assistantMsg?.toolCalls?.[0]).toMatchObject({
      name: 'read_files',
      path: 'src/alpha.txt',
      paths: ['src/alpha.txt', 'src/beta.txt'],
      success: true,
    });
    // Start-of-call timestamp lands on the persisted record and sits at or
    // before the assistant message's own commit time — the replay-timeline
    // contract (intra-turn ordering with absolute time).
    const callAt = assistantMsg?.toolCalls?.[0]?.at;
    expect(callAt).toBeDefined();
    expect(Date.parse(callAt!)).not.toBeNaN();
    expect(Date.parse(callAt!)).toBeLessThanOrEqual(Date.parse(assistantMsg!.at));
  }, 30_000);

  it('ends the sender turn after a successful async handoff instead of nudging it to repeat', async () => {
    await store.createGezel({ name: 'Maya', role: 'Developer' });
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'message_gezel',
        arguments: {
          gezel: 'maya',
          message: 'Check the project status and report back.',
        },
      },
    ]);
    // This text normally trips looksStalled(). The successful fire-and-forget
    // handoff is nevertheless the terminal action for this sender turn.
    mock.script('Let me hand this off.');

    await manager.send(session.id, 'Ask Maya for a project status check.');

    const senderSends = mock.calls.filter(
      (call) => call.kind === 'send' && call.sendOpts?.queue?.sessionId === session.id,
    );
    expect(senderSends).toHaveLength(1);
    const handoffOutput = mock.toolCallOutputs.find(
      (output) => output.name === 'message_gezel',
    )?.output;
    expect(handoffOutput).toContain('END YOUR TURN NOW');
    expect(handoffOutput).toMatch(
      /Maya's provider queue|Maya's turn has entered the provider queue/,
    );
    expect(handoffOutput).toMatch(/releases (?:the slot|its provider slot)/);
  }, 30_000);

  it('runs the generate_image tool and writes a real PNG to project artifacts', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'generate_image',
        arguments: {
          prompt: 'a tiny abstract compass',
          width: 8,
          height: 8,
          seed: 17,
        },
      },
    ]);
    mock.script('Here is your compass.');

    await manager.send(session.id, 'draw me a compass');

    const genOutput = mock.toolCallOutputs.find((o) => o.name === 'generate_image');
    expect(genOutput?.output).toMatch(/Generated 8×8 image/);
    expect(genOutput?.output).toMatch(/artifacts\/generated\//);

    // The PNG should exist on disk under the default project's artifacts.
    const generatedDir = join(svc.context.home, 'projects', 'default', 'artifacts', 'generated');
    const entries = await (await import('node:fs/promises')).readdir(generatedDir);
    const png = entries.find((f) => f.endsWith('.png'));
    expect(png).toBeDefined();
    const bytes = await readFile(join(generatedDir, png!));
    // PNG signature
    expect(
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
  }, 30_000);

  it('captures a failed tool call onto the assistant message for the post-stream expando', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    // `read_document` against a path that doesn't exist → bridge returns
    // "ERROR: ..." and onToolCall fires with success=false. The failure
    // is what the user tends to remember afterward, so it's exactly the
    // case where the persisted tool history matters most.
    mock.scriptToolCalls([{ name: 'read_document', arguments: { path: 'does-not-exist.md' } }]);
    mock.script('Could not find the doc.');

    await manager.send(session.id, 'read me that missing doc');

    const disk = await store.getSession('ada', session.id);
    const assistantMsg = disk!.messages.find((m) => m.content === 'Could not find the doc.');
    expect(assistantMsg?.toolCalls).toBeTruthy();
    expect(assistantMsg!.toolCalls!.length).toBe(1);
    expect(assistantMsg!.toolCalls![0]!.name).toBe('read_document');
    // The failure is what we care about — the expando renders it as a red X.
    expect(assistantMsg!.toolCalls![0]!.success).toBe(false);
    expect(assistantMsg!.toolCalls![0]!.errorMessage).toBeTruthy();
  }, 30_000);

  it('nudges with CLOSING_SUMMARY when a turn ran tools but produced no closing text', async () => {
    // Small models often emit only a tool_use block and stop, leaving
    // the user staring at an expanded tool-call card with no narrative.
    // The stall detector should route this through CLOSING_SUMMARY_NUDGE
    // (not the original CONTINUATION_NUDGE, which would tell the model
    // to re-execute the tool — wrong, since the tool already ran).
    const session = await manager.createSession({ gezelId: 'ada' });

    // Turn 1: write a doc, then return EMPTY text. This is the
    // "tool ran, model went silent" scenario the nudge targets.
    mock.scriptToolCalls([
      {
        name: 'write_document',
        arguments: { path: 'silent-tool/note.md', content: '# made silently\n' },
      },
    ]);
    mock.script('');
    // Turn 2 (the synthetic nudge): a real wrap-up sentence.
    mock.script('Wrote silent-tool/note.md.');

    await manager.send(session.id, 'write the note');

    // The nudge prompt the supervisor sent on the second turn carries
    // a distinctive phrase from CLOSING_SUMMARY_NUDGE. Match a stable
    // substring so minor wording changes don't break the test.
    const sends = mock.calls.filter((c) => c.kind === 'send');
    const nudgeSend = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(nudgeSend).toBeDefined();

    // And critically: the persisted session has both bubbles — the
    // tool-only one (with the toolCalls expando) and the wrap-up text.
    // The user gets to see "what happened" via the expando AND the
    // closing sentence, instead of just an orphaned tool card.
    const disk = await store.getSession('ada', session.id);
    const assistantMsgs = disk!.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
    const toolOnlyMsg = assistantMsgs.find(
      (m) => m.content === '' && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(toolOnlyMsg).toBeDefined();
    expect(toolOnlyMsg!.toolCalls![0]!.name).toBe('write_document');
    const wrapUpMsg = assistantMsgs.find((m) => m.content === 'Wrote silent-tool/note.md.');
    expect(wrapUpMsg).toBeDefined();
  }, 30_000);

  it('continues a task after a read-only tool instead of summarizing and stopping', async () => {
    await store.writeProjectWorkspaceFile('default', 'src/game.js', 'export const speed = 1;\n');
    const task = await svc.context.tasks.create('default', {
      title: 'Tune the game',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          name: 'Edit',
          prompt:
            'First call `read_file` on `src/game.js`, then call `replace_in_file` to change the speed from 1 to 2.',
        },
        { name: 'Evaluate', assignee: { kind: 'user' } },
      ],
    });
    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });

    mock.scriptToolCalls([{ name: 'read_file', arguments: { path: 'src/game.js' } }]);
    mock.scriptToolCalls([
      {
        name: 'replace_in_file',
        arguments: {
          path: 'src/game.js',
          find: 'speed = 1',
          replace: 'speed = 2',
        },
      },
    ]);
    mock.script('', 'Updated src/game.js.');

    await manager.send(session.id, 'Continue the current step.');

    const sends = mock.calls.filter((call) => call.kind === 'send');
    expect(
      sends.some((call) => /read-only tool returned useful context/i.test(call.prompt ?? '')),
    ).toBe(true);
    expect(sends.some((call) => /No more tools — just words/i.test(call.prompt ?? ''))).toBe(false);
    await expect(store.readProjectWorkspaceFile('default', 'src/game.js')).resolves.toBe(
      'export const speed = 2;\n',
    );
    expect(mock.toolCallOutputs.map((output) => output.name)).toEqual([
      'read_file',
      'replace_in_file',
    ]);
  }, 30_000);

  it('continues an untasked PowerPoint request from suggest_craftbook through invoke_craftbook', async () => {
    // This test owns the suggest -> invoke conversation contract, not the
    // package installer. Seed an exact roster-only dependency so invoking
    // the PowerPoint craftbook cannot turn into a live registry fetch.
    const docblocks = await svc.context.catalog.get('toolset', 'docblocks');
    if (!docblocks || docblocks.manifest.kind !== 'toolset') {
      throw new Error('DocBlocks catalog fixture missing');
    }
    await store.writeInstalledToolsets({ kind: 'project', projectId: 'default' }, [
      {
        toolsetId: 'docblocks',
        sourceId: docblocks.sourceId,
        version: docblocks.manifest.version,
        installedAt: '2026-08-10T00:00:00.000Z',
        runtime: docblocks.manifest.runtime,
      },
    ]);
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'suggest_craftbook',
        arguments: { query: 'create a PowerPoint about the Battle of Ypres' },
      },
    ]);
    mock.scriptToolCalls([
      {
        name: 'invoke_craftbook',
        arguments: {
          craftbookId: 'powerpoint-deck',
        },
      },
    ]);
    mock.script(
      'I found the matching PowerPoint recipe.\n\nI will invoke it now.',
      'The PowerPoint recipe is running for the Battle of Ypres presentation.',
    );

    const toolEvents: Extract<import('@bendyline/gezel').ChatEvent, { type: 'tool' }>[] = [];
    const unsubscribe = events.subscribe(session.id, (event) => {
      if (event.type === 'tool') toolEvents.push(event);
    });

    await manager.send(session.id, 'Can you create a PowerPoint about the Battle of Ypres?');
    unsubscribe();

    const sends = mock.calls.filter((call) => call.kind === 'send');
    const progressNudge = sends.find((call) =>
      /read-only tool returned useful context/i.test(call.prompt ?? ''),
    );
    expect(progressNudge).toBeDefined();
    expect(progressNudge?.prompt).toContain('If the lookup result named a next tool call');
    expect(sends.some((call) => /No more tools — just words/i.test(call.prompt ?? ''))).toBe(false);
    expect(mock.toolCallOutputs.map((output) => output.name)).toEqual([
      'suggest_craftbook',
      'invoke_craftbook',
    ]);
    expect(mock.toolCallOutputs[0]?.output).toContain('"craftbookId":"powerpoint-deck"');
    expect(mock.toolCallOutputs[0]?.output).toContain(
      'create a PowerPoint about the Battle of Ypres',
    );
    expect(mock.toolCallOutputs[1]?.output).toContain('Invoked craftbook "powerpoint-deck"');
    expect(mock.toolCallOutputs.map((output) => output.name)).not.toContain('start_project');
    expect(mock.toolCallOutputs.map((output) => output.name)).not.toContain('message_gezel');

    const disk = await store.getSession('ada', session.id);
    const assistantText = disk?.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n');
    expect(assistantText).not.toMatch(/(?:created|initiated|started).*project/i);
    expect(assistantText).not.toMatch(/voorman.*(?:recruited|is on it)/i);

    const launched = (await store.listProjectTasks('default')).find(
      (task) => task.craftbook.id === 'powerpoint-deck',
    );

    // The invoke_craftbook tool event carries the inline start card — the
    // snapshot the transcript's craftbook card renders from — and the
    // persisted assistant message's toolCalls entry carries the same card.
    const invokeEvent = toolEvents.find((event) => event.name === 'invoke_craftbook');
    expect(invokeEvent?.card).toMatchObject({
      kind: 'craftbook-start',
      craftbookId: 'powerpoint-deck',
      taskRef: launched?.ref,
      projectId: 'default',
    });
    if (invokeEvent?.card?.kind !== 'craftbook-start') throw new Error('missing start card');
    expect(invokeEvent.card.steps.length).toBe(launched?.craftbook.steps.length);
    expect(invokeEvent.card.steps.map((step) => step.id)).toEqual(
      launched?.craftbook.steps.map((step) => step.id),
    );
    const persistedInvoke = (await store.getSession('ada', session.id))?.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.name === 'invoke_craftbook');
    expect(persistedInvoke?.card).toEqual(invokeEvent.card);

    expect(launched?.description).toBe('Can you create a PowerPoint about the Battle of Ypres?');
    expect(launched?.craftbookParams?.topic).toBe(
      'Can you create a PowerPoint about the Battle of Ypres?',
    );
    expect(launched?.craftbook.steps[0]?.prompt).toContain(
      'Topic: `Can you create a PowerPoint about the Battle of Ypres?`',
    );
  }, 30_000);

  it('stamps a step-advance card on the advance_task_step tool call', async () => {
    const task = await svc.context.tasks.create('default', {
      title: 'Two-step march',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        { name: 'Draft', prompt: 'Write the draft.' },
        { name: 'Evaluate', assignee: { kind: 'user' } },
      ],
    });
    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });

    mock.scriptToolCalls([
      { name: 'advance_task_step', arguments: { ref: task.ref, stepId: task.activeStepId } },
    ]);
    mock.script('', 'Draft done — handed to you for evaluation.');

    const toolEvents: Extract<import('@bendyline/gezel').ChatEvent, { type: 'tool' }>[] = [];
    const unsubscribe = events.subscribe(session.id, (event) => {
      if (event.type === 'tool') toolEvents.push(event);
    });
    await manager.send(session.id, 'Continue the current step.');
    unsubscribe();

    const advanceEvent = toolEvents.find((event) => event.name === 'advance_task_step');
    expect(advanceEvent?.card).toMatchObject({
      kind: 'task-step-advance',
      taskRef: task.ref,
      projectId: 'default',
      completedStepId: task.activeStepId,
    });
    if (advanceEvent?.card?.kind !== 'task-step-advance') throw new Error('missing advance card');
    // The snapshot shows the walk moved: Draft done, Evaluate active.
    expect(advanceEvent.card.steps.map((step) => step.status)).toEqual(['done', 'active']);
    expect(advanceEvent.card.completedStepName).toBe('Draft');
    expect(advanceEvent.card.activeStepName).toBe('Evaluate');
  }, 30_000);

  it('persists gate infrastructure diagnostics on the assistant message', async () => {
    const project = await store.createProject({ name: 'Gate diagnostics' });
    const task = await svc.context.tasks.create(project.id, {
      title: 'Build the page',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          name: 'Build',
          prompt: 'Create `index.html` with `write_file`.',
          advanceWhen: { file: 'index.html', minBytes: 20 },
        },
        { name: 'Evaluate', assignee: { kind: 'user' } },
      ],
    });
    manager.setTaskAdvancer(async () => ({
      status: 'held',
      message: 'Gate script "checkHtmlComplete" failed.',
      messageFingerprint: 'gate-infra',
      attempt: 0,
      paused: true,
      infrastructureError: true,
      scriptRuns: [
        {
          scriptName: 'checkHtmlComplete',
          runId: 'run-diagnostic-123',
          error: 'script exited with code 1 without stderr output',
        },
      ],
    }));
    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: project.id,
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    mock.scriptToolCalls([
      {
        name: 'write_file',
        arguments: {
          path: 'index.html',
          content: '<!doctype html><html><head><title>Game</title></head><body>Ready</body></html>',
        },
      },
    ]);
    mock.script('Built the page.');

    await manager.send(session.id, 'Build it.');

    expect(mock.toolCallOutputs.find((output) => output.name === 'write_file')?.output).toMatch(
      /Wrote index\.html/,
    );
    await expect(store.readProjectWorkspaceFile(project.id, 'index.html')).resolves.toContain(
      '<title>Game</title>',
    );
    const disk = await store.getSession('ada', session.id);
    const reply = disk?.messages.find((message) => message.content === 'Built the page.');
    expect(reply?.warnings).toEqual([expect.stringContaining('run-diagnostic-123')]);
    expect(reply?.warnings?.[0]).toContain('script exited with code 1 without stderr output');
    expect(
      mock.calls.filter(
        (call) => call.kind === 'send' && call.sendOpts?.queue?.lane === 'interactive',
      ),
    ).toHaveLength(1);
  }, 30_000);

  it('settles a successful deliverable write when a later tool-loop aborts the turn', async () => {
    const project = await store.createProject({ name: 'Abort recovery' });
    const task = await svc.context.tasks.create(project.id, {
      title: 'Build the page',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          name: 'Build',
          prompt: 'Create `index.html` with `write_file`, then record the result.',
          advanceWhen: {
            file: 'index.html',
            minBytes: 20,
            requireChange: true,
          },
        },
        { name: 'Evaluate', assignee: { kind: 'user' } },
      ],
    });
    const entryStepId = task.activeStepId!;
    const nextStepId = task.craftbook.steps[1]!.id;
    manager.setTaskAdvancer(async (projectId, num, stepId, goto) => {
      const outcome = await svc.context.tasks.completeStepChecked(projectId, num, stepId, goto, {
        cause: 'auto',
      });
      return outcome.status === 'advanced'
        ? { status: 'advanced' as const }
        : {
            status: 'held' as const,
            message: outcome.gate.message,
            messageFingerprint: outcome.gate.messageFingerprint,
            attempt: outcome.gate.attempt,
          };
    });
    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: project.id,
      taskRef: task.ref,
      stepId: entryStepId,
    });
    mock.scriptToolCalls([
      {
        name: 'write_file',
        arguments: {
          path: 'index.html',
          content: '<!doctype html><html><body><main>Ready</main></body></html>',
        },
      },
      {
        name: 'write_task_note',
        arguments: { ref: task.ref, text: 'The page was written.' },
      },
    ]);
    mock.scriptSendFailureAfterToolCalls(
      '[mock] aborting — `write_task_note` repeated 5 times in a row this turn',
    );

    await expect(manager.send(session.id, 'Build it.')).rejects.toThrow(/write_task_note/);

    await expect(store.readProjectWorkspaceFile(project.id, 'index.html')).resolves.toContain(
      '<main>Ready</main>',
    );
    const updated = await store.readTask(project.id, task.num);
    expect(updated!.activeStepId).toBe(nextStepId);
    const disk = await store.getSession('ada', session.id);
    const aborted = disk!.messages.at(-1)!;
    expect(aborted.synthetic).toBe('turn-aborted');
    expect(aborted.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'write_file', success: true }),
        expect.objectContaining({ name: 'write_task_note', success: true }),
      ]),
    );
  }, 30_000);

  it('skips CLOSING_SUMMARY after validation repair writes so checks can rerun', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'write_file',
        arguments: { path: 'src/app.js', content: 'export const ok = true;\n' },
      },
    ]);
    mock.script('');

    await manager.send(
      session.id,
      '[Message from Orion]: [runtime check seed-tasks-render] The app still fails. Patch src/app.js now.',
    );

    const sends = mock.calls.filter((c) => c.kind === 'send');
    const nudgeSend = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(nudgeSend).toBeUndefined();
    expect(sends).toHaveLength(1);

    const onDisk = await store.readProjectWorkspaceFile('default', 'src/app.js');
    expect(onDisk).toBe('export const ok = true;\n');

    const disk = await store.getSession('ada', session.id);
    const toolOnlyMsg = disk!.messages.find(
      (m) => m.role === 'assistant' && m.content === '' && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(toolOnlyMsg?.toolCalls?.[0]?.name).toBe('write_file');
  }, 30_000);

  it('skips CLOSING_SUMMARY after repeat and escalated validation repair writes', async () => {
    const prompts = [
      "[Message from Nadia]: REPEAT MISS — attempt 2 on `repeat.md`: the same check is still failing.\n\n[scenario check] I looked at `repeat.md` and the success criteria aren't met yet.",
      "REPEAT APPEND MISS — attempt 2 on `append.md`: the append did not clear the check.\n\n[scenario check] I looked at `append.md` and the success criteria aren't met yet.",
      "REPEAT COMBINED MISS — attempt 3 on `combined.md`: the multi-defect repair did not clear the checks.\n\n[scenario check] I looked at `combined.md` and the success criteria aren't met yet.",
      'GATE_FULL_REWRITE: 3 completed repairs of `rewrite.md` have failed this scenario check with the exact same result — targeted edits are not landing.',
    ];

    for (const [index, prompt] of prompts.entries()) {
      const session = await manager.createSession({ gezelId: 'ada' });
      mock.scriptToolCalls([
        {
          name: 'write_file',
          arguments: {
            path: `validation-repair-${index}.md`,
            content: `repair ${index}\n`,
          },
        },
      ]);
      mock.script('');

      await manager.send(session.id, prompt);
    }

    const sends = mock.calls.filter((c) => c.kind === 'send');
    const nudgeSend = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(nudgeSend).toBeUndefined();
    for (const prompt of prompts) {
      expect(sends.filter((call) => call.prompt === prompt)).toHaveLength(1);
    }

    for (const index of prompts.keys()) {
      const onDisk = await store.readProjectWorkspaceFile(
        'default',
        `validation-repair-${index}.md`,
      );
      expect(onDisk).toBe(`repair ${index}\n`);
    }
  }, 30_000);

  it('skips CLOSING_SUMMARY after direct file-work mutations so external checks can run', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'write_file',
        arguments: { path: 'out/customers.json', content: '[]\n' },
      },
    ]);
    mock.script('');

    await manager.send(
      session.id,
      'Please clean up the export and produce the normalized out/customers.json. Write the result to out/customers.json as a single JSON array.',
    );

    const sends = mock.calls.filter((c) => c.kind === 'send');
    const nudgeSend = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(nudgeSend).toBeUndefined();
    expect(sends).toHaveLength(1);

    const onDisk = await store.readProjectWorkspaceFile('default', 'out/customers.json');
    expect(onDisk).toBe('[]\n');
  }, 30_000);

  it('still fires CLOSING_SUMMARY_NUDGE under aiEngagementMode=reactive', async () => {
    // Within-turn recovery from a stalled tool-only response is part of
    // fulfilling the user's already-sent message — not new ambient
    // outreach. `reactive` users still want their empty-bubble turn to
    // recover. Regression test for the engagement-mode gate split:
    // before the fix, `isProactiveAllowed` short-circuited the nudge
    // and a tiny llama-cpp model that emitted one tool call and stopped
    // would strand the user on an empty bubble.
    await store.writeConfig({ aiEngagementMode: 'reactive' });
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'write_document',
        arguments: { path: 'reactive-recovery/note.md', content: '# made silently\n' },
      },
    ]);
    mock.script('');
    mock.script('Wrote reactive-recovery/note.md.');

    await manager.send(session.id, 'write the note');

    const sends = mock.calls.filter((c) => c.kind === 'send');
    const nudgeSend = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(nudgeSend).toBeDefined();
  }, 30_000);

  it('does NOT fire any nudge when aiEngagementMode=off', async () => {
    // The kill-switch still works: `off` blocks every nudge variant,
    // including the within-turn recoveries. Counterpart to the
    // reactive-mode test — together they pin the boundary.
    await store.writeConfig({ aiEngagementMode: 'off' });
    const session = await manager.createSession({ gezelId: 'ada' });

    mock.scriptToolCalls([
      {
        name: 'write_document',
        arguments: { path: 'off-mode/note.md', content: '# made silently\n' },
      },
    ]);
    mock.script('');

    await manager.send(session.id, 'write the note');

    const sends = mock.calls.filter((c) => c.kind === 'send');
    const nudgeSend = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(nudgeSend).toBeUndefined();
  }, 30_000);

  it('uses the original CONTINUATION_NUDGE (not closing summary) when no tools ran', async () => {
    // The flip side: a stalled turn with NO tools is the original
    // "you said you would, but didn't actually call the tool" case.
    // The nudge text differs and matters — pointing the model at "wrap
    // up" when it never even tried would let it off the hook.
    const session = await manager.createSession({ gezelId: 'ada' });
    mock.script("I'll work on that next.", 'Fine, I did the thing.');

    await manager.send(session.id, 'do the thing');

    const sends = mock.calls.filter((c) => c.kind === 'send');
    // CONTINUATION_NUDGE always tells the model to act now —
    // wording has shifted as the nudge generalized from "announced
    // an action" to "described what you would do or what you read",
    // but the imperative stays.
    const continuation = sends.find(
      (c) => /take that step now/i.test(c.prompt ?? '') || /act\b/i.test(c.prompt ?? ''),
    );
    expect(continuation).toBeDefined();
    // And the closing-summary wording must NOT have been used here.
    const closingSummary = sends.find((c) => /No more tools — just words/i.test(c.prompt ?? ''));
    expect(closingSummary).toBeUndefined();
  }, 30_000);
});
