import { spawn } from 'node:child_process';
import { createAwakeTimeout } from '@bendyline/gezel';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import { winShellSafe } from '../../packages/win-shell.js';
import { killProcessTree } from '../../utils/kill-process-tree.js';
import { resolveCodexBinary } from '../codex-cli/binary.js';

export type RpcRecord = Record<string, unknown>;
export function record(value: unknown): RpcRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RpcRecord)
    : {};
}

export interface CodexImageClient {
  request(method: string, params?: RpcRecord): Promise<RpcRecord>;
  onNotification(listener: (method: string, params: RpcRecord) => void): () => void;
  stop(): Promise<void>;
}

export interface CodexImageClientOptions {
  cwd: string;
  signal: AbortSignal;
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** Preserve the CLI's credential store while disabling unrelated integrations in this process. */
export const CODEX_IMAGE_CONFIG: RpcRecord = {
  model_provider: 'openai',
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  'skills.include_instructions': false,
  'features.skip_host_skill_discovery': true,
  'features.image_generation': true,
  // The native image extension lives in this host, even without code-mode turns.
  'features.code_mode_host': true,
  'features.omit_app_server_notification_media': false,
  ...Object.fromEntries(
    [
      'apps',
      'plugins',
      'remote_plugin',
      'hooks',
      'shell_tool',
      'unified_exec',
      'code_mode',
      'multi_agent',
      'multi_agent_v2',
      'browser_use',
      'computer_use',
      'in_app_browser',
      'search_tool',
      'memories',
      'goals',
    ].map((name) => [`features.${name}`, false]),
  ),
  'agents.enabled': false,
};

/** A dedicated stdio app-server; never connects to or interrupts the user's running Codex app. */
export async function createCodexImageClient(
  opts: CodexImageClientOptions,
): Promise<CodexImageClient> {
  const binary = await resolveCodexBinary({ override: opts.binaryPath, env: opts.env });
  opts.signal.throwIfAborted();
  const args = ['--no-daemon', 'app-server', '--stdio'];
  for (const [key, value] of Object.entries(CODEX_IMAGE_CONFIG))
    args.push('-c', `${key}=${JSON.stringify(value)}`);
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary.path);
  const target = winShellSafe(binary.path, args, useShell);
  const child = spawn(target.command, target.args, {
    cwd: opts.cwd,
    // Inherit CODEX_HOME and OS credential access. Do not copy or parse auth files.
    env: opts.env ?? process.env,
    shell: useShell,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...windowsHeadlessSpawnOptions(),
  });
  const pending = new Map<
    number,
    { resolve: (value: RpcRecord) => void; reject: (error: Error) => void }
  >();
  const listeners = new Set<(method: string, params: RpcRecord) => void>();
  let sequence = 0;
  let buffer = '';
  let failure: Error | undefined;
  let closed = false;
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  const send = (message: unknown) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    for (const listener of listeners) listener('error', { error: { message: error.message } });
    if (!closed) killProcessTree(child);
  };
  const abort = () =>
    fail(
      opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error('Codex image request cancelled.'),
    );
  opts.signal.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', (error) => fail(error));
  child.on('error', (error) => fail(error));
  child.on('close', () => fail(new Error('Codex CLI exited before completing the image request.')));
  // Drain diagnostics, without exposing credentials or unrelated user config in an error message.
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    // Native image events carry base64 PNGs; bound even an unterminated protocol line.
    if (buffer.length > 96 * 1024 * 1024)
      return fail(new Error('Codex returned an oversized image event.'));
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) continue;
      let message: RpcRecord;
      try {
        message = record(JSON.parse(line));
      } catch {
        fail(new Error('Codex returned an invalid app-server response.'));
        return;
      }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          // No shell, filesystem, MCP, OAuth, or other approval can be granted by this adapter.
          send({
            id: message.id,
            error: { code: -32601, message: 'Only native image generation is supported.' },
          });
          fail(
            new Error(
              'Codex requested an unsupported tool or approval while generating the image.',
            ),
          );
          return;
        }
        for (const listener of listeners) listener(message.method, record(message.params));
      } else if (typeof message.id === 'number') {
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          call?.reject(new Error(String(record(message.error).message ?? 'Codex request failed.')));
        else call?.resolve(record(message.result));
      }
    }
  });
  const client: CodexImageClient = {
    request: (method, params = {}) =>
      new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: async () => {
      opts.signal.removeEventListener('abort', abort);
      listeners.clear();
      fail(new Error('Codex image connection closed.'));
      if (!closed) {
        const timeout = createAwakeTimeout(5_000);
        try {
          await Promise.race([
            exited,
            new Promise<void>((resolve) =>
              timeout.signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
          ]);
        } finally {
          timeout.dispose();
        }
      }
    },
  };
  try {
    if (opts.signal.aborted) abort();
    await client.request('initialize', {
      clientInfo: { name: 'gezel_image', title: 'Gezel image generation', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized' });
    return client;
  } catch (error) {
    await client.stop();
    throw error;
  }
}
