import { createLogger, turnCancelledMessage } from '@bendyline/gezel';
import type { NativeVisionPreference } from '../vision-capability.js';
import type { MlxEngineGate } from './engine-gate.js';
import { TOOL_IMAGES_MESSAGE } from './tool-image-retention.js';

const log = createLogger('mlx');

/**
 * When an MLX engine loads its vision tower.
 *
 * `--vision` makes the sidecar load mlx_vlm's full multimodal tower, and for
 * the architectures that otherwise get mlx_lm's text tower that tax lands on
 * every text turn: 32 -> 45 ms/token at 11k context and 41 -> 87 at 54k on
 * qwen3.8-27b (the `[tower]` note in gezel_mlx_server.py). So a checkpoint
 * that has a vision tower starts text-only (`on-demand`) and reloads once, the
 * first time a request carries pixels, then stays in vision mode for the rest
 * of that engine process. An explicit per-model `config.nativeVision` wins:
 * `true` is `always`, `false` is `never`.
 */
export type MlxVisionPolicy = 'always' | 'on-demand' | 'never';

export function resolveMlxVisionPolicy(opts: {
  preference: NativeVisionPreference;
  hasVisionTower: boolean;
}): MlxVisionPolicy {
  if (!opts.hasVisionTower || opts.preference === 'off') return 'never';
  return opts.preference === 'on' ? 'always' : 'on-demand';
}

/**
 * Disk-cache segment for one launch. KV persisted by mlx_lm's text tower and
 * by mlx_vlm's tower is not interchangeable — the saved cache classes come
 * from different packages, and the vlm tower keeps multimodal position state
 * the text tower never wrote — so the two must never restore each other's
 * entries. The text segment keeps the historical fingerprint: every release
 * before on-demand vision launched text-only, and its caches stay valid.
 */
export function mlxCacheFingerprint(modelFingerprint: string, vision: boolean): string {
  return vision ? `${modelFingerprint}-vision` : modelFingerprint;
}

interface VisionMessage {
  role: string;
  content?: unknown;
  images?: string[];
}

/** Why this request needs the vision tower, or `undefined` when it carries no pixels. */
export function describeVisionNeed(
  messages: readonly VisionMessage[],
  turnStartIdx: number,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const count = messages[i]?.images?.length ?? 0;
    if (count === 0) continue;
    if (messages[i]?.content === TOOL_IMAGES_MESSAGE) {
      return `a tool returned ${count} image(s) to inspect`;
    }
    return i >= turnStartIdx
      ? `${count} image(s) attached to this message`
      : `${count} image(s) attached earlier in the conversation`;
  }
  return undefined;
}

/**
 * Suffix for a successful tool result whose images a text-only engine cannot
 * be shown. The tool's real work — a generated image on disk, a rendered
 * poster — already happened; reporting it as a failure made the model run
 * the GPU-heavy generation again until the failure tracker aborted the turn.
 */
export function unseenToolImagesNote(count: number): string {
  return count > 0
    ? `\n\n[The tool succeeded. It also returned ${count} image(s), which were not shown to you because this model runs without image input. Do not describe what they show.]`
    : '';
}

function withoutImages<T extends VisionMessage>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    const { images, ...rest } = message;
    const note = `[${images.length} image(s) could not be shown here: this model is running without image input.]`;
    const content =
      message.content === TOOL_IMAGES_MESSAGE
        ? note
        : `${String(message.content ?? '')}\n\n${note}`;
    return { ...rest, content } as T;
  });
}

interface VisionSupervisor {
  ensureRunning(): Promise<unknown>;
  stop(): Promise<void>;
  lifecycleSnapshot(): { running: boolean };
}

/**
 * The caller stops waiting when its turn is cancelled; the reload itself runs
 * to completion, because other sessions are parked behind it.
 */
function untilDoneOrCancelled(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(turnCancelledMessage()));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One MLX engine's tower, decided per launch. The supervisor calls
 * {@link takeLaunch} from `resolveLaunch`; sessions call {@link prepareRequest}
 * before every request. A switch holds every engine-gate slot, so it waits for
 * in-flight requests of other sessions instead of killing them, then reloads
 * through the supervisor's own stop/start — the pool entry, its reservation
 * and its idle accounting never change.
 */
export class MlxVisionMode {
  private pendingReason: string | undefined;
  private launchedWithVision = false;
  private unavailableReason: string | undefined;
  private supervisor: VisionSupervisor | undefined;
  private gate: Pick<MlxEngineGate, 'acquireAll'> | undefined;
  private isDisposed: () => boolean = () => false;
  private switching: Promise<void> | undefined;

  constructor(
    readonly policy: MlxVisionPolicy,
    private readonly label = 'model',
  ) {}

  /** A tower fixed at construction: an external server, or a test double. */
  static fixed(visionEnabled: boolean): MlxVisionMode {
    return new MlxVisionMode(visionEnabled ? 'always' : 'never');
  }

  bindEngine(
    supervisor: VisionSupervisor | undefined,
    gate: Pick<MlxEngineGate, 'acquireAll'>,
    isDisposed: () => boolean,
  ): void {
    this.supervisor = supervisor;
    this.gate = gate;
    this.isDisposed = isDisposed;
  }

  /** Whether images can reach the model — now, or after one reload into the vision tower. */
  get capable(): boolean {
    return this.policy !== 'never' && this.unavailableReason === undefined;
  }

  /** Whether the current (or most recent) engine process loaded the vision tower. */
  get active(): boolean {
    return this.launchedWithVision;
  }

  /**
   * Decide this launch's tower. Called once per engine start; a pending
   * request is consumed, so the process after this one starts text-only
   * again unless something asks for vision.
   */
  takeLaunch(): boolean {
    this.launchedWithVision =
      this.capable && (this.policy === 'always' || this.pendingReason !== undefined);
    this.pendingReason = undefined;
    return this.launchedWithVision;
  }

  /**
   * The request's messages, bound for an engine that can read them. When no
   * vision tower can be loaded the pixels are replaced with an honest note,
   * because the sidecar rejects image requests on a text-only launch.
   */
  async prepareRequest<T extends VisionMessage>(
    messages: T[],
    turnStartIdx: number,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const reason = describeVisionNeed(messages, turnStartIdx);
    if (!reason || (await this.ensureVision(reason, signal))) return messages;
    return withoutImages(messages);
  }

  async ensureVision(reason: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.capable) return false;
    if (this.policy === 'always') return true;
    if (!this.supervisor || !this.gate) return false;
    if (this.launchedWithVision && this.supervisor.lifecycleSnapshot().running) return true;
    if (!this.switching) {
      this.switching = this.switchToVision(reason).finally(() => {
        this.switching = undefined;
      });
      // A caller that stopped waiting must not turn a failed reload into an
      // unhandled rejection; callers still waiting receive it.
      this.switching.catch(() => undefined);
    }
    await untilDoneOrCancelled(this.switching, signal);
    return this.capable;
  }

  private async switchToVision(reason: string): Promise<void> {
    const supervisor = this.supervisor!;
    this.pendingReason ??= reason;
    log.info(`switching ${this.label} to vision mode (reason: ${reason})`);
    const release = await this.gate!.acquireAll('vision-switch');
    try {
      if (this.isDisposed()) return;
      // A stopped engine launches straight into vision; a launch already under
      // way settles first and is reloaded below if it came up text-only.
      await supervisor.ensureRunning();
      if (this.launchedWithVision || this.isDisposed()) return;
      await supervisor.stop();
      if (this.isDisposed()) return;
      await supervisor.ensureRunning();
    } catch (err) {
      // A text launch that failed is the engine's own failure, not vision's.
      // Never relaunch for a provider the pool already retired.
      if (!this.launchedWithVision || this.isDisposed()) throw err;
      this.unavailableReason = err instanceof Error ? err.message : String(err);
      log.warn(
        `${this.label}: the vision tower failed to load (${this.unavailableReason}); continuing text-only`,
      );
      await supervisor.ensureRunning().catch(() => undefined);
    } finally {
      release();
    }
  }
}
