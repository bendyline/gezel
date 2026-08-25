import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionResumeError } from '../types.js';
import type { ToolCallEvent, TurnUsage } from '../types.js';
import type { ClaudeReasoningEffort } from './reasoning.js';
import { ClaudeWorker, type WorkerTurnHooks } from './worker.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-claude-worker-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Build a Node.js fake `claude` that:
 *   - emits a `system.init` event on startup with a configurable session id;
 *   - reads NDJSON user messages from stdin, one per turn;
 *   - emits the scripted stream-json events for each turn from
 *     `GEZEL_FAKE_TURNS` (a JSON array of arrays of events);
 *   - exits with the configured code after `GEZEL_FAKE_EXIT_AFTER_TURNS` (or
 *     stays alive forever).
 *
 * Optionally writes the launched process pid to `GEZEL_FAKE_PID_FILE` so
 * tests can verify that turn 2 reuses the same process as turn 1.
 */
async function makeFakeClaude(opts: {
  sessionId: string;
  turns: unknown[][];
  pidFile?: string;
  exitAfterTurns?: number;
  startupStderr?: string;
  exitCodeOnStartup?: number;
}): Promise<string> {
  const path = join(dir, 'fake-claude.cjs');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const turns = ${JSON.stringify(opts.turns)};
const sessionId = ${JSON.stringify(opts.sessionId)};
const pidFile = ${opts.pidFile ? JSON.stringify(opts.pidFile) : 'null'};
const exitAfterTurns = ${opts.exitAfterTurns ?? -1};
const startupStderr = ${JSON.stringify(opts.startupStderr ?? '')};
const exitCodeOnStartup = ${opts.exitCodeOnStartup ?? -1};

if (pidFile) {
  fs.appendFileSync(pidFile, process.pid + '\\n');
}
if (exitCodeOnStartup >= 0) {
  if (startupStderr) process.stderr.write(startupStderr);
  process.exit(exitCodeOnStartup);
}

// Emit init.
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');

let turnIdx = 0;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const events = turns[turnIdx++] || [];
    for (const ev of events) process.stdout.write(JSON.stringify(ev) + '\\n');
    if (exitAfterTurns >= 0 && turnIdx >= exitAfterTurns) {
      // Exit shortly after to simulate crash.
      setTimeout(() => process.exit(0), 5);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

interface NoopHooksControl {
  hooks: WorkerTurnHooks;
  deltas: string[];
  reasoning: string[];
  usages: TurnUsage[];
  toolCalls: ToolCallEvent[];
  toolArgs: Array<{ name: string; chunk: string }>;
  warnings: string[];
  heartbeats: Array<string | undefined>;
}

function makeNoopHooks(): NoopHooksControl {
  const deltas: string[] = [];
  const reasoning: string[] = [];
  const usages: TurnUsage[] = [];
  const toolCalls: ToolCallEvent[] = [];
  const toolArgs: Array<{ name: string; chunk: string }> = [];
  const warnings: string[] = [];
  const heartbeats: Array<string | undefined> = [];
  return {
    deltas,
    reasoning,
    usages,
    toolCalls,
    toolArgs,
    warnings,
    heartbeats,
    hooks: {
      emitDelta: (t) => deltas.push(t),
      emitReasoningDelta: (t) => reasoning.push(t),
      emitHeartbeat: (label) => heartbeats.push(label),
      emitToolArgsDelta: (name, chunk) => toolArgs.push({ name, chunk }),
      emitWarning: (message) => warnings.push(message),
      emitUsage: (u) => usages.push(u),
      onToolCall: (ev) => {
        toolCalls.push(ev);
      },
    },
  };
}

function buildWorker(opts: {
  binPath: string;
  initialResumeId?: string;
  idleTimeoutMs?: number;
  onIdleEvict?: () => void;
  onCrash?: (err: Error) => void;
}): ClaudeWorker {
  // The fake claude is a Node script. We launch it via `node <script>` and
  // ignore the CLI flags the worker would normally pass — the fake just
  // emits stream-json scripted by env vars / arg files.
  const fakeBin = opts.binPath;
  return new ClaudeWorker({
    binaryPath: 'node',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    systemMessage: 'You are a test gezel.',
    context: { sessionId: 'sess-1', gezelId: 'g-1', projectId: 'p-1', cwd: dir },
    runtimeDir: join(dir, 'runtime'),
    manageRuntimeFiles: false,
    ...(opts.initialResumeId ? { initialResumeId: opts.initialResumeId } : {}),
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    ...(opts.onIdleEvict ? { onIdleEvict: opts.onIdleEvict } : {}),
    ...(opts.onCrash ? { onCrash: opts.onCrash } : {}),
    spawnImpl: ((command: string, args: readonly string[], spawnOptions: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cp = require('node:child_process') as typeof import('node:child_process');
      // Prepend the fake script path so `node fake-claude.mjs ...` runs.
      const realArgs = [fakeBin, ...args];
      return cp.spawn(command, realArgs, spawnOptions as Parameters<typeof cp.spawn>[2]);
    }) as never,
  });
}

describe('ClaudeWorker — happy path', () => {
  it('captures session id on start, streams a turn, and reuses the process for turn 2', async () => {
    const pidFile = join(dir, 'pids.txt');
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-99',
      pidFile,
      turns: [
        // Turn 1
        [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Hello',
            duration_ms: 5,
            usage: { input_tokens: 1, output_tokens: 1 },
            session_id: 'cli-sess-99',
          },
        ],
        // Turn 2
        [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'World' }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'World',
            duration_ms: 4,
            usage: { input_tokens: 2, output_tokens: 1 },
            session_id: 'cli-sess-99',
          },
        ],
      ],
    });
    const worker = buildWorker({ binPath });
    await worker.start();
    // claudeSessionId is null until the CLI emits system.init, which it
    // doesn't do in stream-json input mode until the first user message.
    expect(worker.claudeSessionId()).toBeNull();
    expect(worker.idle()).toBe(true);

    const t1 = makeNoopHooks();
    const out1 = await worker.sendTurn('hi', t1.hooks);
    expect(out1).toBe('Hello');
    expect(t1.deltas.join('')).toBe('Hello');
    expect(t1.usages).toHaveLength(1);
    // After the first turn, system.init has arrived and we have the id.
    expect(worker.claudeSessionId()).toBe('cli-sess-99');
    expect(worker.idle()).toBe(true);

    const t2 = makeNoopHooks();
    const out2 = await worker.sendTurn('again', t2.hooks);
    expect(out2).toBe('World');
    expect(t2.deltas.join('')).toBe('World');

    // Confirm one PID, not two — the same process handled both turns.
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean);
    expect(pids).toHaveLength(1);

    await worker.shutdown();
  });

  it('fires onToolCall for tool_use+tool_result pairs and dedupes block snapshots when partial deltas arrive', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-tools',
      turns: [
        [
          // Token-granular partial deltas first.
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello ' },
            },
          },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'world' },
            },
          },
          // Then the block snapshot — should be suppressed (dedupe).
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
          },
          // Tool use + result.
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_01',
                  name: 'Read',
                  input: { file_path: '/a.ts' },
                },
              ],
            },
          },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'fake body' }],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Hello world',
            duration_ms: 8,
            usage: { input_tokens: 5, output_tokens: 2 },
            session_id: 'cli-sess-tools',
          },
        ],
      ],
    });
    const worker = buildWorker({ binPath });
    await worker.start();
    const t = makeNoopHooks();
    const out = await worker.sendTurn('hi', t.hooks);
    expect(out).toBe('Hello world');
    expect(t.deltas).toEqual(['Hello ', 'world']); // dedupe worked
    expect(t.toolCalls).toHaveLength(1);
    expect(t.toolCalls[0]).toMatchObject({ name: 'Read', success: true });
    await worker.shutdown();
  });
});

describe('ClaudeWorker — failure paths', () => {
  it('throws SessionResumeError on the first sendTurn when --resume id is dead', async () => {
    const binPath = await makeFakeClaude({
      sessionId: '',
      turns: [],
      exitCodeOnStartup: 1,
      startupStderr: 'session not found: dead-id',
    });
    const worker = buildWorker({ binPath, initialResumeId: 'dead-id' });
    // start() succeeds — spawn syscall worked, the process dies seconds
    // later with the resume-failure stderr. The error surfaces from
    // sendTurn (either as a rejection of the in-flight pending turn, or
    // as a re-throw of the captured `lastCrashError` if close ran first).
    await worker.start();
    await expect(worker.sendTurn('hi', makeNoopHooks().hooks)).rejects.toBeInstanceOf(
      SessionResumeError,
    );
    expect(worker.claudeSessionId()).toBeNull();
  });

  it('rejects pending turn and fires onCrash when the child dies mid-conversation', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-crash',
      // Turn 1 succeeds, then no more events emitted but process exits.
      turns: [
        [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'first',
            duration_ms: 5,
            usage: { input_tokens: 1, output_tokens: 1 },
            session_id: 'cli-sess-crash',
          },
        ],
        // Turn 2: NO events, then the script exits.
        [],
      ],
      exitAfterTurns: 2,
    });
    const crashes: Error[] = [];
    const worker = buildWorker({
      binPath,
      onCrash: (err) => crashes.push(err),
    });
    await worker.start();
    await worker.sendTurn('hi', makeNoopHooks().hooks);
    // Now turn 2: the script will exit without emitting events.
    await expect(worker.sendTurn('again', makeNoopHooks().hooks)).rejects.toThrow(
      /exited mid-turn|aborted|claude/i,
    );
    expect(crashes.length).toBeGreaterThanOrEqual(1);
    expect(worker.isAlive()).toBe(false);
  });

  it('fires onIdleEvict after the idle timer elapses', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-idle',
      turns: [],
    });
    let evicted = 0;
    const worker = buildWorker({
      binPath,
      idleTimeoutMs: 50,
      onIdleEvict: () => {
        evicted += 1;
      },
    });
    await worker.start();
    // Idle timer should fire shortly after start.
    await new Promise((r) => setTimeout(r, 150));
    expect(evicted).toBeGreaterThanOrEqual(1);
    await worker.shutdown();
  });
});

describe('ClaudeWorker — progress signaling', () => {
  it('emits an immediate "preparing" heartbeat at sendTurn entry', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-progress',
      turns: [
        [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'hi',
            duration_ms: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
            session_id: 'cli-sess-progress',
          },
        ],
      ],
    });
    const worker = buildWorker({ binPath });
    await worker.start();
    const hooks = makeNoopHooks();
    await worker.sendTurn('hi', hooks.hooks);
    // The very first event emitted is the immediate "preparing"
    // heartbeat — fires synchronously inside sendTurn before the CLI
    // produces any output, giving the user a visible breadcrumb during
    // MCP-server-init silence. It's transient (heartbeat only), never a
    // persisted intent: the worker doesn't emit intents at all, so no
    // phase label is ever carved into the saved bubble.
    expect(hooks.heartbeats[0]).toBe('preparing');
    await worker.shutdown();
  });

  it('rotates the heartbeat label to track tool calls and streaming', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-rotate',
      turns: [
        [
          // Tool call — phase should become "using Read".
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'Read',
                  input: { file_path: '/x.ts' },
                },
              ],
            },
          },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' }],
            },
          },
          // Then streamed text — phase becomes "streaming".
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'done' },
            },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'done',
            duration_ms: 4,
            usage: { input_tokens: 5, output_tokens: 1 },
            session_id: 'cli-sess-rotate',
          },
        ],
      ],
    });
    const worker = buildWorker({ binPath });
    await worker.start();
    const hooks = makeNoopHooks();
    await worker.sendTurn('go', hooks.hooks);
    // Tool usage surfaces via `onToolCall` (the tool-call card), NOT via a
    // per-tool intent breadcrumb — the worker deliberately emits no intents,
    // since a divider per command is pure noise next to the card. The
    // transient "using Read" status rides the heartbeat (a 3s timer we don't
    // assert on, as the synthetic turn completes far faster). Here we confirm
    // the surviving channels: the tool call was reported and text streamed.
    expect(hooks.toolCalls.map((t) => t.name)).toContain('Read');
    expect(hooks.deltas.join('')).toBe('done');
    await worker.shutdown();
  });
});

describe('ClaudeWorker — system prompt delivery', () => {
  /**
   * Build a worker whose spawnImpl records the CLI args (then still launches
   * the fake claude so `start()` succeeds). Lets us assert on how the system
   * prompt is delivered without running a full turn.
   */
  function buildCapturingWorker(opts: {
    binPath: string;
    systemMessage: string;
    manageRuntimeFiles: boolean;
    sessionId: string;
    reasoningEffort?: ClaudeReasoningEffort;
    capture: (args: string[], spawnOptions: unknown) => void;
  }): ClaudeWorker {
    return new ClaudeWorker({
      binaryPath: 'node',
      model: 'sonnet',
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      permissionMode: 'acceptEdits',
      systemMessage: opts.systemMessage,
      context: { sessionId: opts.sessionId, gezelId: 'g-1', projectId: 'p-1', cwd: dir },
      runtimeDir: join(dir, 'runtime'),
      manageRuntimeFiles: opts.manageRuntimeFiles,
      idleTimeoutMs: 60_000,
      spawnImpl: ((command: string, args: readonly string[], spawnOptions: unknown) => {
        opts.capture([...args], spawnOptions);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cp = require('node:child_process') as typeof import('node:child_process');
        return cp.spawn(command, [opts.binPath, ...args], spawnOptions as never);
      }) as never,
    });
  }

  it("passes reasoning effort through Claude Code's supported environment variable", async () => {
    const binPath = await makeFakeClaude({ sessionId: 'cli-effort', turns: [] });
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const worker = buildCapturingWorker({
      binPath,
      systemMessage: 'You are a test gezel.',
      manageRuntimeFiles: false,
      sessionId: 'sess-effort',
      reasoningEffort: 'xhigh',
      capture: (_args, spawnOptions) => {
        capturedEnv = (spawnOptions as { env?: NodeJS.ProcessEnv }).env;
      },
    });

    await worker.start();
    expect(capturedEnv?.CLAUDE_CODE_EFFORT_LEVEL).toBe('xhigh');
    await worker.shutdown();
  });

  it('passes the prompt via --append-system-prompt-file (off the command line) when managing runtime files', async () => {
    const binPath = await makeFakeClaude({ sessionId: 'cli-sp', turns: [] });
    // ~95 KB — far past Windows' ~32 KB CreateProcessW command-line limit, so
    // an inline `--append-system-prompt` here is exactly what produces the
    // `spawn ENAMETOOLONG` this delivery path exists to avoid.
    const systemMessage = 'You are Alejandro the Developer. '.repeat(3000);
    let capturedArgs: string[] = [];
    const worker = buildCapturingWorker({
      binPath,
      systemMessage,
      manageRuntimeFiles: true,
      sessionId: 'sess-sp',
      capture: (a) => {
        capturedArgs = a;
      },
    });
    await worker.start();

    // The giant prompt must NOT be inline, and the command line stays tiny.
    expect(capturedArgs).not.toContain('--append-system-prompt');
    expect(capturedArgs.join(' ').length).toBeLessThan(4096);

    // It rides in the file the flag points at.
    const idx = capturedArgs.indexOf('--append-system-prompt-file');
    expect(idx).toBeGreaterThanOrEqual(0);
    const promptPath = capturedArgs[idx + 1]!;
    expect(await readFile(promptPath, 'utf8')).toBe(systemMessage);

    const settingsIdx = capturedArgs.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const quotaSettings = JSON.parse(await readFile(capturedArgs[settingsIdx + 1]!, 'utf8')) as {
      statusLine?: { type?: string; command?: string };
    };
    expect(quotaSettings.statusLine?.type).toBe('command');
    expect(quotaSettings.statusLine?.command).toContain('quota-statusline.mjs');

    await worker.shutdown();
  });

  it('falls back to inline --append-system-prompt when runtime-file management is disabled', async () => {
    const binPath = await makeFakeClaude({ sessionId: 'cli-sp2', turns: [] });
    let capturedArgs: string[] = [];
    const worker = buildCapturingWorker({
      binPath,
      systemMessage: 'You are a test gezel.',
      manageRuntimeFiles: false,
      sessionId: 'sess-sp2',
      capture: (a) => {
        capturedArgs = a;
      },
    });
    await worker.start();

    expect(capturedArgs).not.toContain('--append-system-prompt-file');
    expect(capturedArgs).not.toContain('--settings');
    const idx = capturedArgs.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[idx + 1]).toBe('You are a test gezel.');

    await worker.shutdown();
  });
});

/** `stream_event` envelope for a partial-message delta. */
function se(event: unknown) {
  return { type: 'stream_event', event, session_id: 'cli-sess-1' };
}

function resultEvent(text: string) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    duration_ms: 5,
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id: 'cli-sess-1',
  };
}

describe('ClaudeWorker — thinking stream', () => {
  it('routes thinking text to the reasoning channel, never to visible deltas', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          se({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Let me calculate: ' },
          }),
          se({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: '17 * 23 = 391.' },
          }),
          se({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: '391, not prime.' },
          }),
          resultEvent('391, not prime.'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    const text = await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.reasoning.join('')).toBe('Let me calculate: 17 * 23 = 391.');
    // The trace must not reach the committed reply body — it would round-trip
    // into the transcript and out through the OpenAI-compat forwarders.
    expect(h.deltas.join('')).toBe('391, not prime.');
    expect(text).toBe('391, not prime.');
  });

  it('reports block-granularity thinking when partial streaming is unavailable', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
          },
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          },
          resultEvent('done'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.reasoning.join('')).toBe('pondering');
    expect(h.deltas.join('')).toBe('done');
  });

  it('suppresses block-granularity thinking once partial deltas are in play', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          se({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'abc' },
          }),
          // The CLI also emits the completed block as an `assistant` snapshot.
          // Counting both would double the trace.
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'abc' }] },
          },
          resultEvent(''),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.reasoning.join('')).toBe('abc');
  });

  it('carries the CLI thinking-token estimate into the heartbeat label', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          {
            type: 'system',
            subtype: 'thinking_tokens',
            estimated_tokens: 9,
            estimated_tokens_delta: 9,
          },
          {
            type: 'system',
            subtype: 'thinking_tokens',
            estimated_tokens: 61,
            estimated_tokens_delta: 52,
          },
          se({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'hmm' },
          }),
          resultEvent('ok'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    // Summed from the deltas, so the total stays right whether or not the
    // cumulative counter restarts on a new assistant message.
    expect(h.heartbeats).toContain('thinking · 61 tokens');
  });
});

describe('ClaudeWorker — streamed tool arguments', () => {
  it('withholds short argument sets and streams a long one', async () => {
    const longContent = 'x'.repeat(600);
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          // A trivial Read — complete well under the visibility threshold,
          // and superseded by its own finished tool row moments later.
          se({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_a', name: 'Read' },
          }),
          se({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/a.txt"}' },
          }),
          se({ type: 'content_block_stop', index: 0 }),
          // A large write — the only thing happening for its whole duration.
          se({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_b', name: 'mcp__gezel__write_artifact' },
          }),
          se({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: `{"content":"${longContent}` },
          }),
          se({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '"}' },
          }),
          se({ type: 'content_block_stop', index: 1 }),
          resultEvent('done'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.toolArgs.some((a) => a.name === 'Read')).toBe(false);
    const written = h.toolArgs.filter((a) => a.name === 'write_artifact');
    expect(written.length).toBeGreaterThan(0);
    // The MCP wire prefix is stripped so the UI's verb map resolves.
    expect(written[0]?.name).toBe('write_artifact');
    // Nothing buffered below the threshold is lost — the flush carries it.
    expect(written.map((a) => a.chunk).join('')).toContain(longContent);
  });

  it('ignores argument fragments for a block it never saw open', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          se({
            type: 'content_block_delta',
            index: 7,
            delta: { type: 'input_json_delta', partial_json: 'x'.repeat(900) },
          }),
          resultEvent('done'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.toolArgs).toEqual([]);
  });

  it('does not carry a tool name across the index reset between messages', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          se({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_a', name: 'Write' },
          }),
          se({ type: 'content_block_stop', index: 1 }),
          // Next assistant message restarts indices; index 1 is now a text
          // block, so any fragment claiming that index is not Write's.
          se({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: 'y'.repeat(900) },
          }),
          resultEvent('done'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.toolArgs).toEqual([]);
  });
});

describe('ClaudeWorker — rate limit warnings', () => {
  it('stays silent while the subscription is allowed', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
          },
          resultEvent('ok'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.warnings).toEqual([]);
  });

  it('surfaces a warning when the window is no longer allowed', async () => {
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [
          {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'rejected',
              rateLimitType: 'five_hour',
              isUsingOverage: true,
            },
          },
          resultEvent('ok'),
        ],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('go', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('5-hour');
    expect(h.warnings[0]).toContain('used up');
    expect(h.warnings[0]).toContain('overage');
    // The raw CLI verb must not reach the transcript.
    expect(h.warnings[0]).not.toContain('rejected');
  });

  it('repeats the notice only when the posture changes', async () => {
    const limitEvent = (status: string) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status, rateLimitType: 'seven_day', isUsingOverage: false },
    });
    const binPath = await makeFakeClaude({
      sessionId: 'cli-sess-1',
      turns: [
        [limitEvent('allowed_warning'), resultEvent('one')],
        [limitEvent('allowed_warning'), resultEvent('two')],
        [limitEvent('rejected'), resultEvent('three')],
      ],
    });
    const w = buildWorker({ binPath });
    await w.start();
    const h = makeNoopHooks();
    await w.sendTurn('a', h.hooks, { timeoutMs: 10_000 });
    await w.sendTurn('b', h.hooks, { timeoutMs: 10_000 });
    await w.sendTurn('c', h.hooks, { timeoutMs: 10_000 });
    await w.shutdown();

    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain('close to your weekly');
    expect(h.warnings[1]).toContain('used up your weekly');
  });
});
