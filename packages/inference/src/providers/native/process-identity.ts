import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * One PID the probe refuses blanks every row in its batch: macOS ps prints
 * "process id too large" past XNU's PID_MAX, and Get-Process -Id binds Int32.
 * A PID past the limit cannot be live, so it is left out like an absent one.
 */
const PROBE_PID_LIMIT: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 99_999,
  win32: 2_147_483_647,
};

/** Birth stamps survive coordinator restarts and distinguish a reused PID. */
export async function readProcessIdentities(
  pids: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const limit = PROBE_PID_LIMIT[process.platform] ?? Number.MAX_SAFE_INTEGER;
  const ids = [...new Set(pids)].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= limit,
  );
  const identities = new Map<number, string>();
  if (!ids.length) return identities;
  try {
    if (process.platform === 'linux') {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      await Promise.all(
        ids.map(async (pid) => {
          const value = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
          if (!value) return;
          // comm may contain spaces and parentheses; fields after its final ')' start at field 3.
          const start = value
            .slice(value.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/)[19];
          if (start && /^\d+$/.test(start)) identities.set(pid, `${boot}:${start}`);
        }),
      );
    } else {
      const windows = process.platform === 'win32';
      const { stdout } = await exec(
        windows ? 'powershell.exe' : 'ps',
        windows
          ? [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + ":" + $_.StartTime.ToUniversalTime().Ticks.ToString() } catch {} }`,
            ]
          : ['-p', ids.join(','), '-o', 'pid=', '-o', 'lstart='],
        {
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 256 * 1024,
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
        },
      ).catch((error: { stdout?: string }) => {
        // ps (and Windows process lookup) may return live rows alongside a missing PID error.
        if (typeof error.stdout === 'string') return { stdout: error.stdout };
        throw error;
      });
      for (const line of stdout.split(/\r?\n/)) {
        const match = windows
          ? /^\s*(\d+):(\d+)\s*$/.exec(line)
          : /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (match && ids.includes(Number(match[1]))) identities.set(Number(match[1]), match[2]!);
      }
    }
  } catch {
    // Access denied or an unavailable OS probe is unknown, never proof of death.
  }
  return identities;
}
