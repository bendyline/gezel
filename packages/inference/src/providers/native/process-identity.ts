import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Birth stamps survive coordinator restarts and distinguish a reused PID. */
export async function readProcessIdentities(
  pids: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const ids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
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
