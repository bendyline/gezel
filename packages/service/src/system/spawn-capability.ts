/**
 * Can this daemon create child processes at all?
 *
 * A boot-time probe, and it exists because the answer was once "no" for
 * every packaged Windows install and nothing said so. v1.26215.31 was the
 * first release whose installer actually registered GezelService on a fresh
 * machine, and it registered it with `sc sidtype ... restricted`. That makes
 * the service token write-restricted; libuv creates a named pipe per piped
 * stdio handle before every `CreateProcess`, and that pipe creation is a
 * write the restricted SID list denies. The daemon booted fine, served
 * HTTPS, read its keychain, indexed its files — and could not spawn a single
 * child. Local engines, GPU probes, the stdio MCP server, sandboxed scripts,
 * pnpm installs and git all failed as `spawn EPERM`, each one reported at
 * its own call site as if it were that feature's own problem.
 *
 * One probe at boot turns that into one sentence. What makes it worth its
 * cost is that the daemon cannot fix the condition — the token is assigned
 * by the service registration — so the only useful thing it can do is say so
 * loudly enough that nobody debugs the engine instead.
 *
 * Windows-only on purpose. The failure mode is a Windows service-token
 * property with no equivalent on the macOS/Linux daemons, and a probe that
 * can only ever answer "ok" is a process spawn nobody needed.
 */
import { spawn } from 'node:child_process';
import { windowsDetachedSpawnOptions } from '@bendyline/gezel/native';

/** `null` means "not applicable here", never "unknown but fine". */
export type SpawnCapability = 'ok' | 'denied' | null;

/**
 * Errno values that mean the OS refused process creation itself, as opposed
 * to the command being wrong. `ENOENT` is deliberately absent: a missing
 * comspec is a broken probe, not a broken token, and reporting it as denied
 * would send users chasing a service-identity problem they do not have.
 */
const DENIED_CODES = new Set(['EPERM', 'EACCES']);

export interface ProbeSpawnOptions {
  platform?: NodeJS.Platform;
  /** Injected by tests; defaults to the real `child_process.spawn`. */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

/**
 * Spawn one trivial child the same way the real call sites do.
 *
 * The stdio shape is the load-bearing part: piped stdout/stderr is what
 * forces libuv to create the named pipes, so a probe with `stdio: 'ignore'`
 * would have passed cleanly on exactly the machines that were broken. The
 * detached option matches the rest of the daemon for the same reason — the
 * probe has to be indistinguishable from the spawns it speaks for.
 *
 * The child's exit code is not consulted. `cmd /c exit` says nothing worth
 * knowing; whether `spawn` itself was permitted is the entire question.
 */
export function probeChildProcessSpawn(options: ProbeSpawnOptions = {}): Promise<SpawnCapability> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return Promise.resolve(null);

  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const comspec = process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';

  return new Promise<SpawnCapability>((resolve) => {
    let settled = false;
    const settle = (result: SpawnCapability): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // A hung probe must not hold up boot. Timing out is reported as `ok`
    // rather than `denied` — the process was created, which is the thing
    // being asked, and a slow machine is not a misconfigured one.
    const timer = setTimeout(() => settle('ok'), timeoutMs);
    timer.unref?.();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(comspec, ['/d', '/c', 'exit'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...windowsDetachedSpawnOptions(platform),
      });
    } catch (err) {
      settle(deniedOrOk(err));
      return;
    }

    child.once('error', (err) => settle(deniedOrOk(err)));
    child.once('spawn', () => {
      settle('ok');
      // Nothing reads this child. Drop the pipes and the process handle so
      // a probe that answered in a millisecond cannot hold the event loop
      // open behind it.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    });
  });
}

function deniedOrOk(err: unknown): SpawnCapability {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? err.code
      : undefined;
  return code !== undefined && DENIED_CODES.has(code) ? 'denied' : 'ok';
}

/**
 * The operator-log line for a denied result.
 *
 * Kept next to the probe so the remediation and the detection cannot drift.
 * It names the exact command because the person reading this log is an
 * administrator on a machine whose service is already installed — telling
 * them to "reinstall" would be both slower and less certain than the one
 * `sc.exe` call that provably fixes it.
 */
export const SPAWN_DENIED_MESSAGE =
  'this daemon cannot create child processes (spawn EPERM). Local models, GPU detection, ' +
  'gezel tools, scripts, and package installs will all fail until this is fixed. On Windows ' +
  'this means the GezelService token is write-restricted; run `sc.exe sidtype GezelService ' +
  'unrestricted` from an elevated prompt and restart the service.';
