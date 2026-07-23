/**
 * macOS sandbox-exec wrapper. We build a minimal `.sb` policy that:
 *   - denies everything by default
 *   - allows reads of system libs, the env workdir, and the scratch dir
 *   - allows writes only to the workdir and scratch dir
 *   - allows process execution (node itself and its children — though
 *     --permission already blocks child_process from the sandboxed script)
 *   - denies outbound network when `denyNet` is set (gate-scripts reach
 *     the host only over their stdio RPC channel, never sockets), else
 *     allows it (e.g. workspace build/test commands that fetch deps)
 *
 * The policy is passed inline via `-p` so we don't need to touch the
 * filesystem. This is Apple's officially undocumented "Seatbelt" language,
 * but it's what Chromium and Apple's own apps use.
 */
export interface RunUnderMacSandboxOptions {
  /**
   * Historically loosened reads to anywhere on the filesystem while
   * keeping writes scoped. Reads are now ALWAYS open (see `buildMacPolicy`
   * — a subpath read allowlist can no longer launch Node once the dyld
   * shared cache moved onto a Cryptex firmlink volume), so this flag no
   * longer changes the emitted policy. Retained so callers
   * (`runWorkspaceCommand`) compile unchanged; the real boundary was
   * always **writes** staying inside the workspace.
   */
  relaxReads?: boolean;
  /**
   * Deny outbound network entirely. Set for gate-scripts, which only
   * ever talk to the host over their stdio RPC channel (fd 3) and never
   * need sockets — so a script can't `fetch()` workspace data out.
   * Default: false (workspace build/test commands may need the network).
   */
  denyNet?: boolean;
}

export function runUnderMacSandbox(
  command: string,
  args: string[],
  ctx: { workdir: string; scratch: string },
  opts: RunUnderMacSandboxOptions = {},
): { command: string; args: string[] } {
  const policy = buildMacPolicy(ctx, opts);
  return {
    command: 'sandbox-exec',
    args: ['-p', policy, command, ...args],
  };
}

function buildMacPolicy(
  ctx: { workdir: string; scratch: string },
  opts: RunUnderMacSandboxOptions,
): string {
  const work = escapePath(ctx.workdir);
  const scratch = escapePath(ctx.scratch);
  // Reads are always open under the sandbox; the enforced boundary is
  // WRITES staying inside the workspace/scratch plus (for denyNet jobs)
  // network. A subpath-restricted read allowlist is NOT viable for
  // launching Node: dyld maps the shared cache during process bring-up,
  // and on macOS 15+ (Sequoia) / 26 (Tahoe) that cache lives on a Cryptex
  // firmlink volume (`/System/Volumes/Preboot/Cryptexes/OS/System/Library/
  // dyld/`) that Seatbelt subpath rules cannot grant — dyld's CacheFinder
  // SIGABRTs before any user code runs, regardless of which subpaths
  // (including `/`, `/System/Volumes`, and the cryptex realpath) are
  // allowed. Only unrestricted `(allow file-read*)` lets Node start.
  // Modern Node additionally scatters startup reads across locale/icu4c
  // tables outside any tight list. `relaxReads` is retained for API
  // compatibility but no longer narrows reads — read confinement was
  // always a best-effort confidentiality nicety, never the boundary the
  // security model rests on, and a denyNet script that reads a stray file
  // still cannot exfiltrate it (network denied) or persist it outside the
  // workspace (writes scoped).
  const readBlock = '(allow file-read*)';
  return `
(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow iokit-open)
${readBlock}
(allow file-write*
  (subpath "${work}")
  (subpath "${scratch}")
  (subpath "/private/var/folders"))
${opts.denyNet ? '(deny network*)' : '(allow network*)'}
`.trim();
}

function escapePath(p: string): string {
  return p.replace(/"/g, '\\"');
}
