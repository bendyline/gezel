/**
 * Windows console-allocation policy for spawned native children.
 *
 * Console-subsystem executables (llama-server, ds4-server, bundled Node)
 * get a console allocated by the loader unless the creator says otherwise.
 * Under the machine-wide service that allocation fails: the daemon runs in
 * non-interactive Session 0 under a restricted service SID, where — as
 * `native/helpers/service-host/src/main.cpp` records — AllocConsole does
 * not survive. CreateProcess then fails and Node surfaces it as
 * `spawn EPERM`.
 *
 * `windowsHide` is NOT the flag for this. It maps to `CREATE_NO_WINDOW`,
 * which still allocates a console — it only withholds the window. The flag
 * that allocates no console at all is `DETACHED_PROCESS`, which Node
 * exposes as `detached: true`.
 *
 * `detached` is deliberately scoped to win32. On POSIX the same option
 * means `setsid()`, which changes process-group and signal semantics that
 * callers may depend on; there is no console problem to solve there.
 */
export function windowsDetachedSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: true } | Record<string, never> {
  return platform === 'win32' ? { detached: true } : {};
}
