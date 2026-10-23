/**
 * The camera family: discovery, a test picture for the setup panel, the live
 * preview, and the adapter the live host runs per camera binding. Holds the
 * shared pieces — one capture per physical camera, one vision queue for the
 * whole install — so per-binding state stays inside `run`.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  CameraBackend,
  CameraDiscoveryResponse,
  CameraEvent,
  ChatEvent,
  ProjectConnectorBinding,
} from '@bendyline/gezel';
import { createLogger, localDayHour, parseCameraBindingConfig } from '@bendyline/gezel';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { projectCapturesDir } from '@bendyline/gezel/paths';
import type { Store } from '../../../fs/store.js';
import { type FfmpegInfo, locateFfmpeg } from '../../../media/ffmpeg.js';
import { connectorCorpusStorage } from '../../storage.js';
import { sha8 } from '../../writer.js';
import { type LiveAdapter, LiveAdapterError, type LiveRunContext } from '../types.js';
import {
  type CameraFrame,
  type CaptureError,
  FfmpegFrameSource,
  type FrameSource,
} from './capture-process.js';
import { CapturesStore } from './captures-store.js';
import { FFMPEG_MISSING_TEXT, discoverCameras } from './discovery.js';
import { CameraEventWriter } from './event-writer.js';
import { backendFor, captureMarker } from './ffmpeg-args.js';
import { type CameraLookoutView, CameraPipeline } from './pipeline.js';
import { CameraReviewer, type CameraReviewerDeps } from './reviewer.js';
import { SimulatedFrameSource, cameraSimulatorEnabled } from './simulator.js';
import { CameraSourcePool, type CameraSourceSpec } from './source-pool.js';

const log = createLogger('camera');

export const CAMERA_ADAPTER_ID = 'camera-local';
/** Event records older than this are swept with their keyframes. */
export const EVENT_RETENTION_DAYS = 90;
const MAINTENANCE_EVERY_MS = 60 * 60_000;
const INDEX_REFRESH_EVERY_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const GB = 1024 ** 3;

/** What the camera pipeline needs from the lookout engine. */
export interface CameraLookoutSink {
  view(projectId: string, bindingId: string): CameraLookoutView;
  lookoutName(projectId: string, lookoutId: string): string | undefined;
  accept(event: CameraEvent): void;
}

/** The slice of `RecognitionManager` the camera uses. */
export interface CameraRecognition {
  recognize: CameraReviewerDeps['recognize'];
  isAvailable(): Promise<boolean>;
}

export interface CameraServiceOptions {
  home: string;
  store: Pick<Store, 'projectArtifactsDir' | 'projectQuarantineDir' | 'getProject'>;
  recognition: CameraRecognition;
  publishProject(projectId: string, event: ChatEvent): void;
  refreshArtifacts?(projectId: string): Promise<unknown>;
  platform?: NodeJS.Platform;
  locateFfmpeg?(): Promise<FfmpegInfo | null>;
  /** Tests inject a frame source per device. */
  createSource?(spec: CameraSourceSpec): FrameSource;
}

export class CameraService implements LiveAdapter {
  readonly heartbeatTimeoutMs = 30_000;
  readonly pool: CameraSourcePool;
  readonly reviewer: CameraReviewer;
  private sink: CameraLookoutSink | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly lastIndexRefresh = new Map<string, number>();

  constructor(private readonly opts: CameraServiceOptions) {
    this.platform = opts.platform ?? process.platform;
    this.pool = new CameraSourcePool((spec) => this.createSource(spec));
    const recognition = opts.recognition;
    this.reviewer = new CameraReviewer({
      recognize: (input) => recognition.recognize(input),
      available: () => recognition.isAvailable(),
    });
  }

  setLookoutSink(sink: CameraLookoutSink): void {
    this.sink = sink;
  }

  discover(): Promise<CameraDiscoveryResponse> {
    return discoverCameras(this.platform);
  }

  private specFor(device: string): CameraSourceSpec {
    const backend: CameraBackend = device.startsWith('simulator:')
      ? 'simulator'
      : backendFor(this.platform);
    return { backend, device };
  }

  private async createSource(spec: CameraSourceSpec): Promise<FrameSource> {
    if (this.opts.createSource) return this.opts.createSource(spec);
    if (spec.backend === 'simulator') {
      if (!cameraSimulatorEnabled()) {
        throw new LiveAdapterError(
          'The simulated camera is only available with GEZEL_CAMERA_SIMULATOR set.',
          true,
        );
      }
      // GEZEL_CAMERA_SIMULATOR_START skips ahead in the scene (seconds), so
      // a demo or smoke run need not sit through the empty room first.
      const startSeconds = Number(process.env.GEZEL_CAMERA_SIMULATOR_START ?? 0);
      return new SimulatedFrameSource(
        Number.isFinite(startSeconds) && startSeconds > 0
          ? { startAt: Math.round(startSeconds * 2) }
          : {},
      );
    }
    const ffmpeg = await (this.opts.locateFfmpeg ?? locateFfmpeg)();
    if (!ffmpeg) throw new LiveAdapterError(FFMPEG_MISSING_TEXT, true);
    return new FfmpegFrameSource({
      ffmpegPath: ffmpeg.path,
      backend: spec.backend,
      device: spec.device,
      marker: captureMarker(sha8(this.opts.home), sha8(spec.device)),
      videoSize: '1280x720',
      platform: this.platform,
    });
  }

  /** One picture from a camera, for the setup panel. Shares a running capture. */
  async probe(device: string): Promise<Buffer> {
    const spec = this.specFor(device);
    const live = this.pool.latest(spec);
    if (live) return live.jpeg;
    const lease = await this.pool.acquire(spec);
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new LiveAdapterError('The camera did not send a picture in time.')),
          PROBE_TIMEOUT_MS,
        );
        lease.onFrame((f) => {
          clearTimeout(timer);
          resolve(f.jpeg);
        });
        lease.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      await lease.release();
    }
  }

  /** The newest picture of a running camera binding, for the live preview. */
  preview(binding: ProjectConnectorBinding): CameraFrame | null {
    const config = parseCameraBindingConfig(binding.config);
    if (!config.device) return null;
    return this.pool.latest(this.specFor(config.device));
  }

  capturesFor(projectId: string, binding: ProjectConnectorBinding): CapturesStore {
    const config = parseCameraBindingConfig(binding.config);
    const corpus = basename(binding.corpusDir ?? binding.id) || 'camera';
    return new CapturesStore({
      root: join(projectCapturesDir(this.opts.home, projectId), corpus),
      keepDays: config.keepDays,
      maxBytes: config.maxGigabytes * GB,
    });
  }

  async run(ctx: LiveRunContext): Promise<void> {
    const config = parseCameraBindingConfig(ctx.binding.config);
    if (!config.device) {
      throw new LiveAdapterError('Pick a camera in this connection’s settings.', true);
    }
    const projectId = ctx.project.id;
    const bindingId = ctx.binding.id;
    const { storageDir, quarantineDir } = await connectorCorpusStorage(
      this.opts.store as Store,
      projectId,
      ctx.corpusDir,
    );
    // The writer resolves every path inside these roots, which must exist.
    await mkdir(storageDir, { recursive: true });
    await mkdir(quarantineDir, { recursive: true });
    const captures = this.capturesFor(projectId, ctx.binding);
    const events = new CameraEventWriter({
      storageDir,
      quarantineDir,
      corpusDir: ctx.corpusDir,
      bindingId,
      cameraLabel: ctx.label,
      lookoutName: (id) => this.sink?.lookoutName(projectId, id),
    });
    const pipeline = new CameraPipeline({
      projectId,
      bindingId,
      cameraLabel: ctx.label,
      config,
      captures,
      events,
      reviewer: this.reviewer,
      lookouts: () => this.sink?.view(projectId, bindingId) ?? { questions: [], motion: false },
      reviewAllowed: () => ctx.reviewAllowed(),
      onEvent: (event) => {
        this.opts.publishProject(projectId, {
          type: 'camera_event',
          projectId,
          bindingId,
          episodeId: event.episodeId,
          phase: event.phase,
          ...((event.review?.frame ?? event.keyframePaths[0])
            ? { keyframe: (event.review?.frame ?? event.keyframePaths[0]) as string }
            : {}),
        });
        this.sink?.accept(event);
      },
      onStatus: (patch) => ctx.report(patch),
      onRecordWritten: () => this.refreshIndex(projectId),
      signal: ctx.signal,
    });

    ctx.report({
      state: 'starting',
      review: !config.review ? 'off' : ctx.reviewAllowed() ? 'ready' : 'held',
    });
    if (config.review) {
      void this.opts.recognition
        .isAvailable()
        .then((ok) => {
          if (!ok && !ctx.signal.aborted && !config.device.startsWith('simulator:')) {
            ctx.report({ review: 'no-model' });
          }
        })
        .catch(() => {});
    }

    const maintain = () =>
      void Promise.all([
        captures.sweep().catch((err) => log.warn('captures sweep failed:', err)),
        this.sweepOldEvents(storageDir, ctx.corpusDir).then((removed) => {
          if (removed > 0) this.refreshIndex(projectId, true);
        }),
      ]);
    maintain();
    const maintenance = setInterval(maintain, MAINTENANCE_EVERY_MS);
    maintenance.unref?.();

    const lease = await this.pool.acquire(this.specFor(config.device));
    try {
      await new Promise<void>((resolve, reject) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        lease.onError((err: CaptureError) => reject(err));
        lease.onFrame((frame) => {
          ctx.heartbeat();
          pipeline.feed(frame);
        });
      });
    } finally {
      clearInterval(maintenance);
      await pipeline.close().catch(() => {});
      await lease.release().catch(() => {});
    }
  }

  private refreshIndex(projectId: string, now = false): void {
    if (!this.opts.refreshArtifacts) return;
    const last = this.lastIndexRefresh.get(projectId) ?? 0;
    if (!now && Date.now() - last < INDEX_REFRESH_EVERY_MS) return;
    this.lastIndexRefresh.set(projectId, Date.now());
    this.opts.refreshArtifacts(projectId).catch(() => {});
  }

  /** Remove event days older than the retention window. */
  private async sweepOldEvents(storageDir: string, corpusDir: string): Promise<number> {
    try {
      const eventsDir = await resolveInside(storageDir, `${corpusDir}/events`);
      const cutoff = localDayHour(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60_000).day;
      let removed = 0;
      for (const day of await readdir(eventsDir).catch(() => [] as string[])) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
          await rm(join(eventsDir, day), { recursive: true, force: true });
          removed++;
        }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  async stop(): Promise<void> {
    await this.pool.stopAll();
  }
}
