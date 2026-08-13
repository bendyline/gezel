/**
 * Windows console-window policy for owned child processes.
 *
 * Node documents `detached: true` on Windows as giving the child its own
 * console window. That is the opposite of what short-lived helpers and
 * supervised engines want: it is what caused Windows Terminal to flash a
 * fresh command prompt for every native signature check. `windowsHide` is
 * the dedicated Node/libuv option for suppressing a subprocess console
 * window, and it leaves the child's lifetime and process-group ownership
 * unchanged.
 *
 * Keep this win32-only. The option is ignored on POSIX, but omitting it there
 * makes the platform contract explicit and keeps captured spawn options
 * deterministic in tests.
 */
export function windowsHeadlessSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { windowsHide: true } | Record<string, never> {
  return platform === 'win32' ? { windowsHide: true } : {};
}

/**
 * Windows options for a genuine fire-and-forget child that must outlive its
 * parent. Detachment is a lifetime decision, not a headless-launch strategy;
 * pair it with `windowsHide` so Windows does not surface the child's new
 * console while it starts.
 *
 * Most callers should use {@link windowsHeadlessSpawnOptions}. In particular,
 * awaited probes, package installers, and supervised engines are owned
 * children and must not be detached.
 */
export function windowsDetachedSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: true; windowsHide: true } | Record<string, never> {
  return platform === 'win32' ? { detached: true, windowsHide: true } : {};
}

/*
 * A Windows `spawn EPERM` under the machine service is not fixed by either
 * helper. The historical failure came from a write-restricted service token:
 * libuv could not create the named pipes used for piped stdio. The installer
 * now assigns an unrestricted service SID, and `probeChildProcessSpawn`
 * detects a recurrence at boot. If that error returns, inspect the token
 * rather than changing console flags.
 */
