/**
 * Node opens an inspector in a running process on request from any process
 * of the same account: SIGUSR1 on POSIX, `process._debugProcess(pid)` on
 * Windows. Node's permission model does not stop a script from sending
 * either, so a sandboxed script could open the daemon's inspector, attach to
 * `ws://127.0.0.1:9229` and run code inside it, with the secret store and
 * every project in reach. `--disable-sigusr1` turns off both paths; it was
 * tested against Node 24 on Linux and Windows and against Electron 43 run as
 * Node, the binary the desktop app spawns its daemon with.
 */
export const DISABLE_DEBUG_SIGNAL_FLAG = '--disable-sigusr1';

/**
 * The flag for a Node child of this binary, or nothing when the binary does
 * not know it (Node before 22.14, which refuses an unknown option outright).
 * Only valid when the child runs `process.execPath`; a different binary is
 * asked through its `--help` output instead.
 */
export function debugSignalLockArgs(
  allowed: ReadonlySet<string> | undefined = process.allowedNodeEnvironmentFlags,
): string[] {
  return allowed?.has(DISABLE_DEBUG_SIGNAL_FLAG) ? [DISABLE_DEBUG_SIGNAL_FLAG] : [];
}
