import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ScriptExecutionOptions,
  ScriptExecutionResult,
  ScriptExecutor,
} from '@bendyline/gezel-script-runtime';
import { runInSandbox } from '../sandbox/runner.js';
import { SDK_PACKAGE_NAME, resolveSdkDir, shouldVendorSdkPath } from './sdk.js';

/** Desktop executor. The runner retains permissions, traces, and persistence. */
export class NodeScriptExecutor implements ScriptExecutor {
  async execute(options: ScriptExecutionOptions): Promise<ScriptExecutionResult> {
    const raw = await mkdtemp(join(tmpdir(), 'gezel-script-'));
    try {
      // Node's permission checks compare canonical paths. In particular,
      // /var/folders on macOS resolves beneath /private/var/folders.
      const scratch = await realpath(raw);
      await writeFile(join(scratch, 'user-script.ts'), options.source, 'utf8');
      await writeFile(
        join(scratch, 'package.json'),
        JSON.stringify(
          { name: `gezel-script-${options.scriptName}`, type: 'module', private: true },
          null,
          2,
        ),
      );
      const sdkDir = await resolveSdkDir();
      const target = join(scratch, 'node_modules', SDK_PACKAGE_NAME);
      await mkdir(dirname(target), { recursive: true });
      await cp(sdkDir, target, {
        recursive: true,
        filter: (src) => shouldVendorSdkPath(sdkDir, src),
      });
      return await this.runSandbox(scratch, options);
    } finally {
      // Setup failures must not leak the source or partially vendored SDK.
      await rm(raw, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private runSandbox(
    scratch: string,
    options: ScriptExecutionOptions,
  ): Promise<ScriptExecutionResult> {
    let sendFrame: ((line: string) => void) | null = null;
    return runInSandbox({
      entry: 'user-script.ts',
      cwd: scratch,
      input: `${JSON.stringify(options.init)}\n`,
      timeoutMs: options.timeoutMs,
      stripTypes: true,
      // Raw Node networking must not bypass the host capability dispatcher.
      denyNet: true,
      // Only host-verified source can use existing desktop fallback lanes.
      allowMissingNetBoundary: options.provenanceTrusted,
      allowMacSandboxStartupFallback: options.trustedReadOnlyStandard,
      maxOldSpaceMb: 1024,
      // Node and its vendored SDK need reads outside the scratch directory.
      // Writes stay scoped; networking and host capabilities remain gated.
      relaxReads: true,
      extraEnv: { GEZEL_SCRIPT_RUNTIME: '1' },
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      rpcChannel: {
        onLine: (line) => {
          let msg: { id?: number; method?: string; params?: unknown };
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof msg.id === 'number' && typeof msg.method === 'string') {
            options
              .onRequest(msg.method, msg.params)
              .then((result) => sendFrame?.(`${JSON.stringify({ id: msg.id, result })}\n`))
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                const code = (err as { code?: string } | null)?.code;
                sendFrame?.(`${JSON.stringify({ id: msg.id, error: { message, code } })}\n`);
              });
          } else if (typeof msg.method === 'string') {
            options.onNotification(msg.method, msg.params);
          }
        },
        onOpen: (send) => {
          sendFrame = send;
        },
      },
    });
  }
}
