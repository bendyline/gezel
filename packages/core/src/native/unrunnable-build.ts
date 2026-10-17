/**
 * Does an engine exit prove that the llama-server BUILD cannot run on this
 * machine? That is the only kind of crash it is safe to quarantine a backend
 * over (see `llama-quarantine.ts`): the answer decides both whether the next
 * launch routes around the build and what the crash tells the person.
 *
 * Only a death before readiness qualifies. A crash after the engine answered
 * is attributable to the work — a model, a request, an allocation — and
 * demoting a backend over it would leave people on a slow engine for a
 * transient reason.
 *
 * ## Windows
 *
 * A POSIX build that cannot run dies by SIGILL. A Windows process never
 * reports a signal: it exits with an NTSTATUS code, so the SIGILL rule alone
 * never fired there, and a GPU build that crashes on every start was relaunched
 * on every request while the CPU build sat in the next directory. On Windows a
 * GPU (CUDA or Vulkan) build that exits before readiness with one of the
 * statuses below is treated as unrunnable:
 *
 * - illegal / privileged instruction — the SIGILL equivalent.
 * - DLL not found, missing entry point, failed DLL init, wrong image format —
 *   the build cannot load against this machine's driver or runtime DLLs.
 * - access violation and fail-fast abort — how a Vulkan or CUDA driver fault,
 *   or a GGML assert in backend init, ends the process. These are the broad
 *   ones: an access violation can also come from a corrupt model. They are
 *   still taken, because the cost is bounded — only GPU builds are ever
 *   demoted (the CPU build is the floor), and the entry is pinned to the
 *   binary's bytes, so the next engine release lifts it.
 *
 * GPU out-of-memory deaths are excluded: the offload-degrade ladder owns
 * those, and demoting to CPU would hide a capacity problem as a driver one.
 */

const WINDOWS_UNRUNNABLE_STATUS: ReadonlyMap<number, string> = new Map([
  [0xc000001d, 'illegal instruction'],
  [0xc0000096, 'privileged instruction'],
  [0xc0000135, 'a required DLL was not found'],
  [0xc0000139, 'a DLL entry point was not found'],
  [0xc0000142, 'a DLL failed to initialize'],
  [0xc000007b, 'invalid image format'],
  [0xc0000005, 'access violation'],
  [0xc0000409, 'fail-fast abort'],
]);

const GPU_LABEL: Readonly<Record<string, string>> = { cuda: 'CUDA', vulkan: 'Vulkan' };

export interface UnrunnableBuild {
  /** The quarantine entry's `signal`: `SIGILL`, or `exit:0xc0000005`. */
  signal: string;
  /** For logs and the quarantine entry. */
  reason: string;
  /** For the person: what happened, without what Gezel does next. */
  summary: string;
}

/** The exit fields this decision reads; a `NativeEngineExitSnapshot` satisfies it. */
export interface EngineExit {
  code: number | null;
  signal: string | null;
  reachedReady: boolean;
  panicKind?: string;
}

/** `0xc0000005` for an NTSTATUS, the plain number for an ordinary exit code. */
export function formatExitCode(code: number): string {
  const unsigned = code >>> 0;
  return unsigned >= 0xc0000000 ? `0x${unsigned.toString(16).padStart(8, '0')}` : String(code);
}

/**
 * `backend` is a `LlamaBackend`, or the free-form `backend` a launch records
 * in its diagnostics (which can read `unknown`).
 */
export function unrunnableBuildExit(
  exit: EngineExit,
  backend: string | undefined,
  platform: NodeJS.Platform = process.platform,
): UnrunnableBuild | null {
  if (exit.reachedReady) return null;
  if (exit.signal === 'SIGILL') {
    return {
      signal: 'SIGILL',
      reason:
        'crashed with SIGILL before the engine became ready — this build uses CPU instructions ' +
        'this machine does not support, or faulted inside GPU library startup',
      summary:
        'This build cannot run on this machine — it uses CPU instructions this processor does ' +
        'not support, or faulted inside GPU library startup.',
    };
  }
  const gpu = backend && Object.hasOwn(GPU_LABEL, backend) ? GPU_LABEL[backend] : undefined;
  if (platform !== 'win32' || !gpu || exit.code === null) return null;
  if (exit.panicKind === 'cuda-out-of-memory' || exit.panicKind === 'vulkan-out-of-memory') {
    return null;
  }
  const meaning = WINDOWS_UNRUNNABLE_STATUS.get(exit.code >>> 0);
  if (!meaning) return null;
  const status = formatExitCode(exit.code);
  return {
    signal: `exit:${status}`,
    reason: `exited with ${status} (${meaning}) before the engine became ready — the ${gpu} build cannot start with this machine's graphics driver or runtime`,
    summary: `The ${gpu} build crashed while starting on this PC (${status}, ${meaning}).`,
  };
}
