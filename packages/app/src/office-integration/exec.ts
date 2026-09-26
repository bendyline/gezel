import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * The one process-spawning seam for the Office / LibreOffice integration.
 * Tests inject a fake; production spawns without a shell, so paths with
 * spaces, quotes, and ampersands are ordinary arguments, never syntax.
 */
export type ExecFn = (
  command: string,
  args: readonly string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class ExecFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ExecFailure';
  }
}

export const defaultExec: ExecFn = (command, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: opts?.timeout ?? 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errText = String(stderr ?? '');
        if (err) {
          const code =
            typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : null;
          const detail = (errText || out).trim().split(/\r?\n/).slice(-3).join(' ');
          reject(new ExecFailure(detail || err.message, code, out, errText));
          return;
        }
        resolve({ stdout: out, stderr: errText });
      },
    );
  });

export interface ProcessDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
}

/** Windows' own copy, so a PATH entry cannot substitute another binary. */
export function system32Tool(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot?.trim();
  return root ? join(root, 'System32', name) : name;
}

/**
 * Whether any process with one of these exact image names is running.
 * Windows: `tasklist` by image name. macOS / Linux: `pgrep -x`.
 */
export async function isProcessRunning(
  names: readonly string[],
  deps: ProcessDeps = {},
): Promise<boolean> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  for (const name of names) {
    if (platform === 'win32') {
      const { stdout } = await exec(
        system32Tool('tasklist.exe'),
        ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'],
        { timeout: 10_000 },
      ).catch(() => ({ stdout: '', stderr: '' }));
      if (stdout.toLowerCase().includes(`"${name.toLowerCase()}"`)) return true;
    } else {
      const running = await exec('/usr/bin/pgrep', ['-x', name], { timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      if (running) return true;
    }
  }
  return false;
}
