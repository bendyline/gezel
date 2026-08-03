/**
 * Windows console-allocation policy for spawned native children.
 *
 * Console-subsystem executables (llama-server, ds4-server, bundled Node) get
 * a console allocated by the loader unless the creator says otherwise. Under
 * the machine-wide service there is nothing to allocate one from: the daemon
 * runs in non-interactive Session 0, where — as
 * `native/helpers/service-host/src/main.cpp` records — `AllocConsole` fails
 * with error 317. `DETACHED_PROCESS`, which Node exposes as `detached: true`,
 * asks for no console at all.
 *
 * `windowsHide` is NOT that flag. It maps to `CREATE_NO_WINDOW`, which still
 * allocates a console and only withholds the window.
 *
 * `detached` is deliberately scoped to win32. On POSIX the same option means
 * `setsid()`, which changes process-group and signal semantics that callers
 * may depend on; there is no console problem to solve there.
 *
 * ## What this does not fix
 *
 * This helper was introduced in v1.26215.31 believing it fixed the
 * `spawn EPERM` that killed every native-engine launch under the machine
 * service. It did not. That release shipped the flag and the failure
 * continued, on two machines, with the daemon's own log showing the engine,
 * the bundled device-health helper, `nvidia-smi`, `amd-smi` and `rocm-smi`
 * all denied at once. The cause was the service token: `sc sidtype ...
 * restricted` write-restricts it, and libuv creates a named pipe per piped
 * stdio handle before every `CreateProcess`, which that token cannot do. The
 * installer now assigns `unrestricted` (see
 * `packages/app/installer/nsis-hooks.nsh`), and `probeChildProcessSpawn` in
 * the service catches a recurrence at boot.
 *
 * The flag is still correct and still used — a console the service cannot
 * allocate is one Windows should not be asked for — but it is a tidiness
 * measure, not a fix for a permission error. If `spawn EPERM` appears again,
 * do not reach for spawn flags: look at the token.
 */
export function windowsDetachedSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: true } | Record<string, never> {
  return platform === 'win32' ? { detached: true } : {};
}
