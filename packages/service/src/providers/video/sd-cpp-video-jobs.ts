/**
 * sd-server's asynchronous video job API: submit with
 * `POST /sdcpp/v1/vid_gen`, poll `GET /sdcpp/v1/jobs/:id`, and cancel with
 * `POST /sdcpp/v1/jobs/:id/cancel`. Unlike the image path's synchronous
 * `/sdapi` calls, a render here can be stopped without killing the engine:
 * a cancelled job stops at sd-server's next checkpoint and leaves the model
 * loaded for the next clip.
 *
 * The contract is upstream's `examples/server/api.md` at the pinned commit.
 */
import type { AwakeBudget } from '@bendyline/gezel';

export interface SdVideoJobOutput {
  video: Buffer;
  /** `video/webm`, `image/webp` or `video/x-msvideo`. */
  mimeType: string;
  outputFormat: string;
  /** The frame rate the clip plays at; sd-server may override a request's. */
  fps: number;
  /** Frames actually decoded: sd-server snaps a request to the model's frame grid. */
  frameCount: number;
}

/** The job ended without a clip, or sd-server refused it. `code` is sd-server's when it gave one. */
export class SdVideoJobFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SdVideoJobFailedError';
  }
}

/**
 * The caller stopped the render, or its time ran out (`timedOut`). `stopped`
 * says whether sd-server confirmed the job ended; when it did not, the engine
 * may still be computing and the caller should stop it.
 */
export class SdVideoJobCancelledError extends Error {
  constructor(
    message: string,
    readonly stopped: boolean,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'SdVideoJobCancelledError';
  }
}

export interface SdVideoJobOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
  /** Awake-time deadline for the whole render, queueing included. */
  budget: AwakeBudget;
  /** The caller gave up: cancel the job and wait for it to stop. */
  signal?: AbortSignal;
  /** How long a cancelled job may take to reach a checkpoint. Default one minute. */
  cancelGraceMs?: () => number;
  /** While another render holds the engine. */
  onQueued?: (position: number) => void;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

interface JobState {
  status?: string;
  queue_position?: number;
  result?: {
    output_format?: string;
    mime_type?: string;
    fps?: number;
    frame_count?: number;
    b64_json?: string;
  } | null;
  error?: { code?: string; message?: string } | string | null;
}

/** Poll every second for the first minute, then every two: renders take minutes. */
function pollIntervalMs(elapsedMs: number): number {
  return elapsedMs < 60_000 ? 1_000 : 2_000;
}

const QUEUE_FULL_RETRY_MS = 2_000;
const DEFAULT_CANCEL_GRACE_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: JobState['error'], fallback: string): { message: string; code?: string } {
  if (!error) return { message: fallback };
  if (typeof error === 'string') return { message: error };
  return {
    message: error.message?.trim() || fallback,
    ...(error.code ? { code: error.code } : {}),
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { error: text.slice(0, 400) };
  }
}

/** Submit one video job and wait for its clip. */
export async function runSdVideoJob(
  body: Record<string, unknown>,
  opts: SdVideoJobOptions,
): Promise<SdVideoJobOutput> {
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const stopRequested = () => opts.signal?.aborted === true || opts.budget.expired();
  // A deadline is not a person's stop, and must not be reported as one.
  const timedOut = () => opts.signal?.aborted !== true && opts.budget.expired();

  let id: string | undefined;
  while (!id) {
    if (stopRequested())
      throw new SdVideoJobCancelledError('stopped before the render began', true, timedOut());
    const res = await opts.fetchImpl(`${base}/sdcpp/v1/vid_gen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await readJson(res)) as { id?: unknown; error?: JobState['error'] } | null;
    if (res.status === 429) {
      await sleep(QUEUE_FULL_RETRY_MS);
      continue;
    }
    if (res.status !== 202 && !res.ok) {
      const { message, code } = errorText(payload?.error, `sd-server answered ${res.status}`);
      throw new SdVideoJobFailedError(message, code);
    }
    if (typeof payload?.id !== 'string' || payload.id.length === 0) {
      throw new SdVideoJobFailedError('sd-server accepted the render but returned no job id');
    }
    id = payload.id;
  }

  const jobUrl = `${base}/sdcpp/v1/jobs/${encodeURIComponent(id)}`;
  const started = Date.now();
  let cancelSentAt: number | undefined;
  let cancelledForTime = false;
  for (;;) {
    if (cancelSentAt === undefined && stopRequested()) {
      cancelSentAt = Date.now();
      cancelledForTime = timedOut();
      await opts.fetchImpl(`${jobUrl}/cancel`, { method: 'POST' }).catch(() => undefined);
    }
    if (
      cancelSentAt !== undefined &&
      Date.now() - cancelSentAt > (opts.cancelGraceMs?.() ?? DEFAULT_CANCEL_GRACE_MS)
    ) {
      throw new SdVideoJobCancelledError(
        'the render did not stop when asked',
        false,
        cancelledForTime,
      );
    }

    let res: Response;
    try {
      res = await opts.fetchImpl(jobUrl);
    } catch (err) {
      throw new SdVideoJobFailedError(
        `lost the connection to sd-server (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (res.status === 404 || res.status === 410) {
      throw new SdVideoJobFailedError('sd-server no longer has this render; it may have restarted');
    }
    const job = (await readJson(res)) as JobState | null;
    if (!res.ok || !job) {
      throw new SdVideoJobFailedError(`sd-server answered ${res.status} for the render's status`);
    }

    if (job.status === 'completed') {
      const result = job.result;
      if (!result?.b64_json) throw new SdVideoJobFailedError('sd-server finished without a clip');
      return {
        video: Buffer.from(result.b64_json, 'base64'),
        mimeType: result.mime_type ?? 'video/webm',
        outputFormat: result.output_format ?? 'webm',
        fps: typeof result.fps === 'number' ? result.fps : 0,
        frameCount: typeof result.frame_count === 'number' ? result.frame_count : 0,
      };
    }
    if (job.status === 'cancelled') {
      throw new SdVideoJobCancelledError('the render was stopped', true, cancelledForTime);
    }
    if (job.status === 'failed') {
      const { message, code } = errorText(job.error, 'the render failed');
      throw new SdVideoJobFailedError(message, code);
    }
    if (job.status === 'queued' && typeof job.queue_position === 'number') {
      opts.onQueued?.(job.queue_position);
    }
    await sleep(cancelSentAt === undefined ? pollIntervalMs(Date.now() - started) : 500);
  }
}
