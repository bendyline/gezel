import { z } from 'zod';

/**
 * Device connectors: connector types whose binding drives local hardware
 * (`driver: 'device'`) instead of syncing a remote source. Cameras are the
 * first family. A device binding is never synced by the connector loop; the
 * daemon's live host keeps it running and writes only *event records* into
 * the project's corpus. See docs/device-connectors.md.
 */

export const CameraBackendSchema = z.enum(['dshow', 'avfoundation', 'v4l2', 'simulator']);
export type CameraBackend = z.infer<typeof CameraBackendSchema>;

/** One camera the daemon can open. `id` is the stable handle a binding stores. */
export const CameraDeviceSchema = z.object({
  /**
   * Windows: the DirectShow "Alternative name" (survives a replug into the
   * same port). macOS: the AVFoundation device index. Linux: the
   * `/dev/v4l/by-id/*` link, else the `/dev/videoN` node.
   */
  id: z.string().min(1),
  name: z.string(),
  backend: CameraBackendSchema,
});
export type CameraDevice = z.infer<typeof CameraDeviceSchema>;

export const CameraDiscoveryResponseSchema = z.object({
  ffmpeg: z.object({
    available: z.boolean(),
    path: z.string().optional(),
  }),
  cameras: z.array(CameraDeviceSchema),
  /** Plain-language reason the list is empty or incomplete. */
  error: z.string().optional(),
});
export type CameraDiscoveryResponse = z.infer<typeof CameraDiscoveryResponseSchema>;

/**
 * What a camera keeps on disk.
 *  - `interval`: one picture every `intervalSeconds`, always.
 *  - `motion`: pictures every `intervalSeconds` while something moves.
 *  - `interesting`: no picture stream; only the event records a review
 *    found notable (or a lookout matched).
 *  - `latest-only`: nothing on disk; the live preview only.
 */
export const CameraStoragePolicySchema = z.enum([
  'interval',
  'motion',
  'interesting',
  'latest-only',
]);
export type CameraStoragePolicy = z.infer<typeof CameraStoragePolicySchema>;

export const CameraSensitivitySchema = z.enum(['low', 'medium', 'high']);
export type CameraSensitivity = z.infer<typeof CameraSensitivitySchema>;

export const CAMERA_INTERVAL_MIN_SECONDS = 1;
export const CAMERA_INTERVAL_MAX_SECONDS = 60;

/** A camera binding's settings as the live host uses them (always clamped). */
export interface CameraBindingConfig {
  device: string;
  deviceName?: string;
  storage: CameraStoragePolicy;
  intervalSeconds: number;
  sensitivity: CameraSensitivity;
  /** "Recognize what's happening": run the local vision model on motion. */
  review: boolean;
  keepDays: number;
  maxGigabytes: number;
  /** Let cloud models see this camera's pictures. Off unless the person turns it on. */
  allowCloudModels: boolean;
}

const clampNumber = (raw: unknown, min: number, max: number, fallback: number, int = true) => {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  const v = Math.min(max, Math.max(min, n));
  return int ? Math.round(v) : v;
};

/**
 * Read a binding's free-form `config` as a camera config. Never throws: a
 * hand-edited or older config degrades to defaults rather than stopping the
 * camera. `device` is the only field without a default.
 */
export function parseCameraBindingConfig(
  raw: Record<string, unknown> | undefined,
): CameraBindingConfig {
  const c = raw ?? {};
  const storage = CameraStoragePolicySchema.safeParse(c.storage);
  const sensitivity = CameraSensitivitySchema.safeParse(c.sensitivity);
  return {
    device: typeof c.device === 'string' ? c.device : '',
    ...(typeof c.deviceName === 'string' && c.deviceName ? { deviceName: c.deviceName } : {}),
    storage: storage.success ? storage.data : 'interesting',
    intervalSeconds: clampNumber(
      c.intervalSeconds,
      CAMERA_INTERVAL_MIN_SECONDS,
      CAMERA_INTERVAL_MAX_SECONDS,
      10,
    ),
    sensitivity: sensitivity.success ? sensitivity.data : 'medium',
    review: c.review !== false,
    keepDays: clampNumber(c.keepDays, 1, 365, 7),
    maxGigabytes: clampNumber(c.maxGigabytes, 0.1, 1000, 2, false),
    allowCloudModels: c.allowCloudModels === true,
  };
}

export const LiveBindingStateSchema = z.enum([
  /** Opening the device. */
  'starting',
  /** Frames are arriving. */
  'watching',
  /** The person paused it, or emergency stop did. */
  'paused',
  /** A gate holds it (engagement off, posture, project status). Not an error. */
  'held',
  /** It tried and failed; it retries with backoff. */
  'error',
]);
export type LiveBindingState = z.infer<typeof LiveBindingStateSchema>;

export const LiveBindingStatusSchema = z.object({
  projectId: z.string(),
  bindingId: z.string(),
  state: LiveBindingStateSchema,
  /** Plain-language reason for `paused`, `held`, or `error`. */
  reason: z.string().optional(),
  since: z.string(),
  lastFrameAt: z.string().optional(),
  lastMotionAt: z.string().optional(),
  lastEventAt: z.string().optional(),
  /** The episode in progress, when something is moving or present. */
  episode: z
    .object({
      id: z.string(),
      startedAt: z.string(),
      motion: z.boolean(),
      presence: z.boolean(),
    })
    .optional(),
  /** Whether the vision model looks at what moves, and whether it can right now. */
  review: z.enum(['off', 'held', 'ready', 'no-model']).optional(),
  capturesBytes: z.number().nonnegative().optional(),
});
export type LiveBindingStatus = z.infer<typeof LiveBindingStatusSchema>;

export const CameraAnswerSchema = z.object({
  match: z.boolean(),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type CameraAnswer = z.infer<typeof CameraAnswerSchema>;

/** The vision model's structured reading of one frame. */
export const CameraReviewSchema = z.object({
  /** One sentence. Untrusted: text visible in the scene can steer it. */
  summary: z.string(),
  subjects: z.array(z.string()),
  notable: z.boolean(),
  /** Keyed by the question id the pipeline asked (a lookout id). */
  answers: z.record(z.string(), CameraAnswerSchema),
  modelId: z.string().optional(),
  durationMs: z.number().nonnegative(),
  /** Artifact-relative path of the keyframe the review looked at. */
  frame: z.string().optional(),
});
export type CameraReview = z.infer<typeof CameraReviewSchema>;

/**
 * One step of a camera episode, handed to the lookout engine. `started`
 * fires when motion is confirmed, `reviewed` after each vision review,
 * `ended` when the scene has been quiet long enough.
 */
export const CameraEventSchema = z.object({
  projectId: z.string(),
  bindingId: z.string(),
  cameraLabel: z.string(),
  episodeId: z.string(),
  phase: z.enum(['started', 'reviewed', 'ended']),
  at: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  motionPeak: z.number().nonnegative(),
  presence: z.boolean(),
  review: CameraReviewSchema.optional(),
  /** Artifact-relative path of the episode's event record, once written. */
  recordPath: z.string().optional(),
  /** Artifact-relative folder holding the keyframes and `episode.json`. */
  attachmentsDir: z.string().optional(),
  keyframePaths: z.array(z.string()).default([]),
});
export type CameraEvent = z.infer<typeof CameraEventSchema>;

/** One saved picture in a camera's private captures folder. */
export const CameraCaptureSchema = z.object({
  /** Path relative to the camera's captures root (`YYYY-MM-DD/HH/HHMMSS-mmm.jpg`). */
  path: z.string(),
  at: z.string(),
  bytes: z.number().nonnegative(),
});
export type CameraCapture = z.infer<typeof CameraCaptureSchema>;
