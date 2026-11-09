import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type NativeCloudModel,
  type PiRun,
  type PiRunState,
  hiddenPathArgs,
  nativeKeyEnv,
  piPromptAppendix,
} from './pi-harness.ts';

/**
 * The strategy benchmark's second outside tool: OpenCode (https://opencode.ai)
 * works the same request in the same seeded folder, on the same model, with
 * none of Gezel's prompts, tools, gates or recovery.
 *
 * Unlike the pi arm, which calls the daemon's `/v1` directly, this arm takes
 * the product path end to end: the trial daemon's own OpenCode setup
 * (`PUT /api/opencode-setup`, packages/service/src/opencode-setup/manager.ts)
 * writes the managed `opencode.json` and starts the OpenCode bridge, and
 * OpenCode is launched the way Settings tells a person to launch it,
 * `OPENCODE_CONFIG=<that file> opencode`. The bridge is what streams
 * reasoning and incremental tool calls the way OpenCode expects.
 *
 * OpenCode's `bash` tool runs whatever the model writes, so it runs inside
 * bubblewrap like pi: the filesystem is read-only, every home folder is
 * hidden, and only the trial workspace and OpenCode's own state are
 * writable. The network is shared because OpenCode must reach the bridge on
 * loopback; web tools are denied so no arm can look anything up.
 */

export const OPENCODE_BIN = process.env.GEZEL_EVAL_OPENCODE_BIN ?? 'opencode';
const BWRAP = process.env.GEZEL_EVAL_BWRAP ?? '/usr/bin/bwrap';
/**
 * A folder holding `rg`. OpenCode's grep and glob tools run ripgrep, look for
 * it on PATH, and otherwise download one on first use, which the sandbox
 * does not complete: both tools then fail with "ripgrep execution failed",
 * a handicap no person's OpenCode has.
 */
export const OPENCODE_RG_DIR = process.env.GEZEL_EVAL_RG_DIR;

/**
 * What the eval adds on top of the managed config, through
 * `OPENCODE_CONFIG_CONTENT` (merged after `OPENCODE_CONFIG`): the project's
 * about text and, on the book arm, the craftbook description, as instruction
 * files, and no web access. A person's own OpenCode would keep its web tools;
 * the trial folders are offline tasks and pi has none.
 */
export function openCodeOverlay(input: { instructionsPath?: string }): string {
  return JSON.stringify({
    ...(input.instructionsPath ? { instructions: [input.instructionsPath] } : {}),
    permission: { webfetch: 'deny', websearch: 'deny' },
  });
}

/** The bubblewrap command line that confines OpenCode to the workspace and its state folder. */
export function sandboxedOpenCodeCommand(input: {
  opencodeBin: string;
  nodeBin: string;
  workspace: string;
  stateDir: string;
  /** The daemon's `integrations/opencode/` folder: the managed config and its token. */
  integrationDir?: string;
  rgDir?: string;
  args: readonly string[];
  hidden?: readonly string[];
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
      ...(input.hidden ?? hiddenPathArgs()),
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      ...ro(dirname(input.nodeBin)),
      ...ro(dirname(input.opencodeBin)),
      ...(input.rgDir ? ro(input.rgDir) : []),
      ...(input.integrationDir ? ro(input.integrationDir) : []),
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
      input.opencodeBin,
      ...input.args,
    ],
  };
}

/** One `--format json` event line: OpenCode emits one per step, tool and text part. */
export function countOpenCodeEvent(state: PiRunState, line: string): void {
  try {
    const record = JSON.parse(line) as { type?: string };
    if (record.type === 'step_finish') state.turns++;
    else if (record.type === 'tool_use') state.toolCalls++;
    else if (record.type === 'error') state.error ??= line.slice(0, 500);
  } catch {
    // A non-JSON line belongs to stderr's story; the raw stream keeps it.
  }
}

/**
 * Start OpenCode on `request` in `workspace` against the managed config at
 * `configPath`. Events go to `<stateDir>/events.jsonl`; steps and tool calls
 * are counted as they arrive so the trial's progress watchdog sees it working.
 */
export async function startOpenCodeRun(input: {
  /** The managed config; absent when a hosted model runs on OpenCode's own provider. */
  configPath?: string;
  /** `<provider id>/<model id>`: the managed config's names, or OpenCode's own. */
  model: string;
  cloud?: NativeCloudModel;
  workspace: string;
  stateDir: string;
  request: string;
  about?: string;
  missionObjectives?: string;
  book?: { name: string; description: string };
  onExit?: () => Promise<void>;
  log: (line: string) => void;
}): Promise<PiRun> {
  const workspace = await realpath(input.workspace);
  const dirs = ['home', 'config', 'data', 'cache', 'state'] as const;
  for (const d of dirs) await mkdir(join(input.stateDir, d), { recursive: true });
  const appendix = piPromptAppendix({
    ...(input.about ? { about: input.about } : {}),
    ...(input.missionObjectives ? { missionObjectives: input.missionObjectives } : {}),
    ...(input.book ? { book: input.book } : {}),
  });
  const instructionsPath = appendix ? join(input.stateDir, 'instructions.md') : undefined;
  if (instructionsPath && appendix) await writeFile(instructionsPath, `${appendix}\n`);
  const opencodeBin = await realpath(OPENCODE_BIN);
  const args = [
    'run',
    '--format',
    'json',
    '--auto',
    '--pure',
    '--model',
    input.model,
    input.request,
  ];
  const cmd = sandboxedOpenCodeCommand({
    opencodeBin,
    nodeBin: process.execPath,
    workspace,
    stateDir: input.stateDir,
    ...(input.configPath ? { integrationDir: dirname(input.configPath) } : {}),
    ...(OPENCODE_RG_DIR ? { rgDir: OPENCODE_RG_DIR } : {}),
    args,
  });
  input.log(
    `[opencode] starting in ${workspace} model=${input.model}${input.cloud ? " (OpenCode's own provider, default variant)" : ''} book=${input.book ? 'yes' : 'no'} rg=${OPENCODE_RG_DIR ? 'yes' : 'no'}`,
  );
  const child: ChildProcess = spawn(cmd.command, cmd.args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${OPENCODE_RG_DIR ? `${OPENCODE_RG_DIR}:` : ''}${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: join(input.stateDir, 'home'),
      XDG_CONFIG_HOME: join(input.stateDir, 'config'),
      XDG_DATA_HOME: join(input.stateDir, 'data'),
      XDG_CACHE_HOME: join(input.stateDir, 'cache'),
      XDG_STATE_HOME: join(input.stateDir, 'state'),
      ...(input.configPath ? { OPENCODE_CONFIG: input.configPath } : {}),
      ...(input.cloud ? nativeKeyEnv(input.cloud) : {}),
      OPENCODE_CONFIG_CONTENT: openCodeOverlay(instructionsPath ? { instructionsPath } : {}),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
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
      countOpenCodeEvent(state, pending.slice(0, at).replace(/\r$/, ''));
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
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
          `[opencode] after-exit step failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      state.running = false;
      input.log(
        `[opencode] exited code=${code} steps=${state.turns} toolCalls=${state.toolCalls}${state.error ? ` error=${state.error}` : ''}`,
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
