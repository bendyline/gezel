import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The strategy benchmark's outside-tool arm: pi (https://pi.dev) works the
 * same request in the same seeded folder, on the same model behind the trial
 * daemon's `/v1` endpoint, with none of Gezel's prompts, tools, gates or
 * recovery. The model is described to pi the way Gezel's own pi setup does
 * (`buildRoster` in packages/service/src/pi-setup/manager.ts), so this is the
 * product path a person using pi with Gezel's local models gets.
 *
 * Pi's `bash` tool runs whatever the model writes, unsandboxed, so pi runs
 * inside bubblewrap: the filesystem is read-only, every home folder is
 * hidden, and only the trial workspace and pi's own state are writable. The
 * network is shared because pi must reach the daemon on loopback.
 */

/** Where the trial's outside-tool run is kept, so the runner can stop it at teardown. */
export const EXTERNAL_HARNESS_STATE_KEY = 'external-harness';

export const PI_BIN = process.env.GEZEL_EVAL_PI_BIN ?? 'pi';
const BWRAP = process.env.GEZEL_EVAL_BWRAP ?? '/usr/bin/bwrap';
/** pi-setup's output share of the context window, and its ceiling. */
const OUTPUT_LIMIT_SHARE = 0.25;
const MAX_OUTPUT_LIMIT = 32_768;
const DEFAULT_CONTEXT_WINDOW = 32_768;

export interface PiModel {
  id: string;
  contextWindow?: number;
  supportsReasoning?: boolean;
}

/** pi's `models.json`: one provider for the trial daemon, one model, as pi-setup describes it. */
export function piModelsJson(input: { baseUrl: string; token: string; model: PiModel }): string {
  const context = input.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return `${JSON.stringify(
    {
      providers: {
        gezel: {
          name: 'Gezel (local)',
          baseUrl: `${input.baseUrl.replace(/\/+$/, '')}/v1`,
          api: 'openai-completions',
          apiKey: input.token,
          authHeader: true,
          models: [
            {
              id: input.model.id,
              name: input.model.id,
              reasoning: input.model.supportsReasoning === true,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: context,
              maxTokens: Math.max(
                1,
                Math.min(MAX_OUTPUT_LIMIT, Math.floor(context * OUTPUT_LIMIT_SHARE)),
              ),
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** Look the model up on the daemon so pi gets the window Gezel serves it with. */
export async function piModelFromDaemon(
  baseUrl: string,
  token: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PiModel> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const entry = body.data?.find((m) => m.id === id);
    const window = [entry?.context_window, entry?.context_length, entry?.contextWindow].find(
      (v): v is number => typeof v === 'number' && v > 0,
    );
    const reasoning = entry?.supports_reasoning ?? entry?.supportsReasoning;
    return {
      id,
      ...(window ? { contextWindow: window } : {}),
      ...(typeof reasoning === 'boolean' ? { supportsReasoning: reasoning } : {}),
    };
  } catch {
    return { id };
  }
}

export interface PiRunState {
  running: boolean;
  exitCode: number | null;
  turns: number;
  toolCalls: number;
  error?: string;
}

export interface PiRun {
  state: PiRunState;
  stop(): Promise<void>;
  done: Promise<PiRunState>;
}

/** What pi's system prompt gets beyond its own: the sections Gezel's sessions carry. */
export function piPromptAppendix(input: {
  about?: string;
  book?: { name: string; description: string };
}): string | undefined {
  const sections = [
    ...(input.about?.trim() ? [`## About this project\n\n${input.about.trim()}`] : []),
    ...(input.book?.description.trim()
      ? [
          `## The craftbook for this request\n\nThis request comes with the **${input.book.name}** craftbook. ${input.book.description.trim()}`,
        ]
      : []),
  ];
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/** The bubblewrap command line that confines pi to the workspace and its state folder. */
export function sandboxedCommand(input: {
  piBin: string;
  nodeBin: string;
  workspace: string;
  stateDir: string;
  args: readonly string[];
}): { command: string; args: string[] } {
  const ro = (path: string) => ['--ro-bind', path, path];
  return {
    command: BWRAP,
    args: [
      '--ro-bind',
      '/',
      '/',
      '--tmpfs',
      '/home',
      '--tmpfs',
      '/root',
      '--tmpfs',
      '/tmp',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...ro(dirname(input.nodeBin)),
      ...ro(input.piBin),
      '--bind',
      input.workspace,
      input.workspace,
      '--bind',
      input.stateDir,
      input.stateDir,
      '--chdir',
      input.workspace,
      '--unshare-pid',
      '--die-with-parent',
      '--new-session',
      '--',
      input.nodeBin,
      join(input.piBin, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      ...input.args,
    ],
  };
}

/**
 * Start pi on `request` in `workspace`. Its JSONL events go to
 * `<stateDir>/events.jsonl`; turns and tool calls are counted as they
 * arrive so the trial's progress watchdog sees pi working.
 */
export async function startPiRun(input: {
  baseUrl: string;
  token: string;
  model: PiModel;
  workspace: string;
  stateDir: string;
  request: string;
  about?: string;
  book?: { name: string; description: string };
  /** Runs after pi exits and before the run reads as finished. */
  onExit?: () => Promise<void>;
  log: (line: string) => void;
}): Promise<PiRun> {
  const workspace = await realpath(input.workspace);
  await mkdir(join(input.stateDir, 'agent'), { recursive: true });
  await mkdir(join(input.stateDir, 'sessions'), { recursive: true });
  await mkdir(join(input.stateDir, 'home'), { recursive: true });
  await writeFile(
    join(input.stateDir, 'agent', 'models.json'),
    piModelsJson({ baseUrl: input.baseUrl, token: input.token, model: input.model }),
    { mode: 0o600 },
  );
  // The pi install folder: `<prefix>/node_modules/.bin/pi` resolves to the package.
  const piBin = await realpath(PI_BIN);
  const piPrefix = piBin.slice(0, piBin.indexOf('/node_modules/'));
  const appendix = piPromptAppendix({
    ...(input.about ? { about: input.about } : {}),
    ...(input.book ? { book: input.book } : {}),
  });
  const args = [
    '--mode',
    'json',
    '--provider',
    'gezel',
    '--model',
    input.model.id,
    '--session-dir',
    join(input.stateDir, 'sessions'),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--offline',
    ...(appendix ? ['--append-system-prompt', appendix] : []),
    input.request,
  ];
  const cmd = sandboxedCommand({
    piBin: piPrefix,
    nodeBin: process.execPath,
    workspace,
    stateDir: input.stateDir,
    args,
  });
  input.log(
    `[pi] starting in ${workspace} model=${input.model.id} window=${input.model.contextWindow ?? 'default'} reasoning=${input.model.supportsReasoning === true} book=${input.book ? 'yes' : 'no'}`,
  );
  const child: ChildProcess = spawn(cmd.command, cmd.args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: join(input.stateDir, 'home'),
      PI_CODING_AGENT_DIR: join(input.stateDir, 'agent'),
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      // The trial daemon's loopback certificate is self-signed.
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      TERM: 'dumb',
    },
  });
  const state: PiRunState = { running: true, exitCode: null, turns: 0, toolCalls: 0 };
  const events = createWriteStream(join(input.stateDir, 'events.jsonl'));
  const stderr = createWriteStream(join(input.stateDir, 'stderr.log'));
  let pending = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    events.write(chunk);
    pending += chunk.toString('utf8');
    let at = pending.indexOf('\n');
    while (at >= 0) {
      const line = pending.slice(0, at).replace(/\r$/, '');
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
      try {
        const record = JSON.parse(line) as { type?: string; toolResults?: unknown[] };
        if (record.type === 'turn_end') {
          state.turns++;
          state.toolCalls += record.toolResults?.length ?? 0;
        }
      } catch {
        // A non-JSON line belongs to stderr's story; the raw stream keeps it.
      }
    }
  });
  child.stderr!.pipe(stderr);
  const done = new Promise<PiRunState>((resolve) => {
    child.on('error', (err) => {
      state.error = err.message;
    });
    child.on('close', async (code) => {
      state.exitCode = code;
      events.end();
      stderr.end();
      await input.onExit?.().catch((err) => {
        input.log(
          `[pi] after-exit step failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      state.running = false;
      input.log(
        `[pi] exited code=${code} turns=${state.turns} toolCalls=${state.toolCalls}${state.error ? ` error=${state.error}` : ''}`,
      );
      resolve(state);
    });
  });
  return {
    state,
    done,
    async stop() {
      if (!state.running) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await done;
      clearTimeout(timer);
    },
  };
}
