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
 * So does only a death the engine did not explain. When it printed a fault
 * the panic classifier recognizes — an assertion, a CUDA error, an
 * out-of-memory — the line says what failed, and that is a model, a context
 * size or a kernel, not the build. The offload ladder and the person own
 * those. A build that cannot run here dies silently: a missing DLL, a driver
 * fault, an instruction the CPU lacks.
 *
 * One such crash still quarantines nothing: `recordLlamaStartupCrash`
 * (llama-quarantine.ts) counts it, and only `LLAMA_QUARANTINE_STRIKES` in a
 * row, with no successful start between them, write a build down.
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
 * - access violation and fail-fast abort — how a Vulkan or CUDA driver fault
 *   ends the process. These are the broad ones. `abort()` and an uncaught C++
 *   exception also exit 0xc0000409 (measured, under both the static and the
 *   DLL CRT), so a GGML assert in model loading looks exactly like a driver
 *   fault by status alone; the printed-fault rule above is what tells them
 *   apart.
 *
 * ## Linux
 *
 * The same driver faults arrive as signals: SIGSEGV for an access violation,
 * SIGABRT for a fail-fast abort or an uncaught exception (vulkan-hpp throws
 * `vk::IncompatibleDriverError` from instance creation). A GPU build that
 * dies silently by either before readiness counts, under the same printed-
 * fault rule. SIGBUS is left out, as Windows leaves out its in-page error: a
 * model file that fails to page in is the disk, not the build. SIGKILL is
 * left out because the out-of-memory killer sends it.
 *
 * A Linux GPU build that cannot load its GPU library at all does not crash:
 * ggml loads backends with dlopen and, in release builds, skips one that
 * fails without a word, so the build runs on the CPU. Nothing here sees that.
 *
 * ## The one printed fault that counts
 *
 * `cuda-unsupported-device` — no kernel image for this GPU, or PTX the driver
 * cannot compile — names the build and the machine, never the work. It is
 * the only classified kind that counts.
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

const LINUX_UNRUNNABLE_SIGNAL: ReadonlyMap<string, string> = new Map([
  ['SIGSEGV', 'segmentation fault'],
  ['SIGABRT', 'abort'],
]);

const GPU_LABEL: Readonly<Record<string, string>> = { cuda: 'CUDA', vulkan: 'Vulkan' };

export interface UnrunnableBuild {
  /**
   * The quarantine entry's `signal`: a signal name (`SIGILL`, `SIGSEGV`),
   * `exit:0xc0000005`, or `cuda-unsupported-device`.
   */
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

/**
 * What one unrunnable-looking startup crash did to its build's standing. A
 * `strike` leaves the build in use; `quarantined` wrote it down, and
 * `switchedTo` names the build this process launches instead (absent when
 * nothing usable sits beside it, so the switch waits for the next start).
 */
export type StartupCrashVerdict =
  | { kind: 'strike'; strikes: number; threshold: number }
  | { kind: 'quarantined'; switchedTo?: string };

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
  const gpu = backend && Object.hasOwn(GPU_LABEL, backend) ? GPU_LABEL[backend] : undefined;
  if (exit.panicKind === 'cuda-unsupported-device') {
    if (backend !== 'cuda') return null;
    return {
      signal: 'cuda-unsupported-device',
      reason:
        'CUDA reported no kernel image (or unusable PTX) for this GPU before the engine became ready — the CUDA build was not compiled for this GPU, or the driver is too old for it',
      summary:
        'The CUDA build has no code for this graphics card, or the driver is too old for it.',
    };
  }
  // `illegal-instruction` is the supervisor's own label for a SIGILL that
  // printed nothing, so it is the one classified kind that stays silent.
  if (exit.panicKind !== undefined && exit.panicKind !== 'illegal-instruction') return null;
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
  if (!gpu) return null;
  if (platform === 'linux') {
    const meaning = exit.signal ? LINUX_UNRUNNABLE_SIGNAL.get(exit.signal) : undefined;
    if (!exit.signal || !meaning) return null;
    return {
      signal: exit.signal,
      reason: `crashed with ${exit.signal} (${meaning}) before the engine became ready — the ${gpu} build cannot start with this machine's graphics driver or runtime`,
      summary: `The ${gpu} build crashed while starting on this computer (${exit.signal}, ${meaning}).`,
    };
  }
  if (platform !== 'win32' || exit.code === null) return null;
  const meaning = WINDOWS_UNRUNNABLE_STATUS.get(exit.code >>> 0);
  if (!meaning) return null;
  const status = formatExitCode(exit.code);
  return {
    signal: `exit:${status}`,
    reason: `exited with ${status} (${meaning}) before the engine became ready — the ${gpu} build cannot start with this machine's graphics driver or runtime`,
    summary: `The ${gpu} build crashed while starting on this PC (${status}, ${meaning}).`,
  };
}
