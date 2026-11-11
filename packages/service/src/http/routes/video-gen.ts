import { randomUUID } from 'node:crypto';
import {
  type ImageAspectRatio,
  type Question,
  type QuestionIntent,
  type VideoArchitecture,
  VideoGenerationRequestSchema,
  type VideoInputSource,
  type VideoModelFamily,
  chooseVideoModel,
  createLogger,
  nowIso,
  resolveVideoFrames,
  resolveVideoSize,
  videoGeometry,
  videoModelAnimates,
} from '@bendyline/gezel';
import { readImageMeta } from '@bendyline/gezel-inference/internal/utils/image-meta';
import { Hono } from 'hono';
import {
  type DeliveredFile,
  type DeliveredVideo,
  deliverVideo,
} from '../../media/video-delivery.js';
import { RemoteVideoProvider } from '../../providers/video/remote-video.js';
import {
  type InstalledVideoModelInfo,
  VideoCapacityError,
  VideoGenerationCancelledError,
  type VideoInputBytes,
  type VideoProvider,
  VideoRenderTimedOutError,
} from '../../providers/video/types.js';
import { cameraInputWithheld } from '../caller-location.js';
import type { ServiceContext } from '../context.js';
import { videoModelRoutes } from './video-models.js';

const log = createLogger('video-gen');

/** Providers that render on this computer, so a render takes over its graphics memory. */
const LOCAL_VIDEO_ENGINES = new Set(['local', 'diffusers', 'sd-cpp']);

/**
 * Video-generation endpoints. Mounted at `/api/video-gen`. The video
 * sibling of `/api/image-gen` — drives the configured video engine
 * (bundled diffusers/LTX by default).
 *
 * Unlike image generation, the approval gate fires for the LOCAL engine
 * too: a multi-minute, GPU-monopolizing job that evicts the chat model
 * is worth confirming even on-device.
 */
export function videoGenRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/generate', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = VideoGenerationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const req = parsed.data;
    const projectId = req.projectId ?? 'default';
    const saveAs = req.saveAs?.trim() || undefined;
    if (saveAs) {
      const saveAsError = validateSaveAs(saveAs);
      if (saveAsError) return c.json({ error: saveAsError }, 400);
    }

    let provider: VideoProvider;
    try {
      // Route `remote:<id>/…` models to the paired server; else local.
      provider = await ctx.videoProvider.providerForModel(req.model);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    const placement = videoEnginePlacement(provider);
    // Resolve an artifact-path input image to bytes before forwarding. A
    // camera keyframe as the first frame passes the same check as editing it.
    let resolvedInput: VideoInputBytes | undefined;
    let sourceSize: { width: number; height: number } | undefined;
    if (req.inputImage) {
      const withheld = await cameraInputWithheld(
        ctx,
        c,
        projectId,
        [req.inputImage],
        placement,
        'video',
      );
      if (withheld) return c.json({ error: withheld }, 403);
      try {
        resolvedInput = await resolveInputImage(ctx, projectId, req.inputImage);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      const picture = readImageMeta(resolvedInput.data);
      if (!picture) {
        return c.json(
          {
            error: 'The picture to animate is not a PNG, JPEG, GIF or WebP image.',
            code: 'video_source_unreadable',
          },
          400,
        );
      }
      sourceSize = { width: picture.width, height: picture.height };
    }
    if (req.requireImageToVideo && !resolvedInput) {
      return c.json(
        { error: 'Attach the picture to animate.', code: 'video_source_required' },
        400,
      );
    }

    // The model: the one asked for, else the person's default when it can
    // do the job, else one that can (core `chooseVideoModel`).
    const installed = await provider.listInstalledModels().catch(() => []);
    const effectiveModelId = await resolveEffectiveVideoModelId(
      ctx,
      provider,
      req.model,
      Boolean(resolvedInput),
      installed,
    );
    const chosen = installed.find((m) => m.id === effectiveModelId);
    let i2vSkippedReason: string | undefined;
    if (chosen && resolvedInput && !videoModelAnimates(chosen)) {
      if (req.requireImageToVideo) {
        return c.json(
          {
            error: `${chosen.name} makes clips from words only, and no installed video model animates a picture. Download one that does in Settings → Video generation.`,
            code: 'video_i2v_unavailable',
          },
          409,
        );
      }
      i2vSkippedReason = `${chosen.name} makes clips from words only; the picture was not used.`;
      resolvedInput = undefined;
    }
    if (chosen?.imageToVideoOnly && !resolvedInput) {
      return c.json(
        {
          error: `${chosen.name} only animates pictures. Attach the picture to animate.`,
          code: 'video_source_required',
        },
        400,
      );
    }

    // Per-model defaults (native resolution / frame count / fps / steps)
    // from the catalog, so an omitted field uses what the model was tuned
    // for; sizes land on the model's grid, and a picture sets the shape.
    const defaults = await resolveVideoDefaults(ctx, effectiveModelId);
    const sizing = resolveRenderSize(req, defaults, sourceSize);
    const effWidth = sizing.width;
    const effHeight = sizing.height;
    const effNumFrames = sizing.numFrames;
    const effFps = req.fps ?? defaults.fps;
    const effSteps = req.steps ?? defaults.steps;
    // No request-level override yet — the per-model catalog default (low
    // for distilled few-step models, higher for dev) is what matters.
    const effGuidanceScale = defaults.guidanceScale;

    // Confirmation gate — agent-driven calls (gezelId+sessionId present)
    // consult `videoGenerationConfirmation`. Applies to local + cloud
    // alike (see the route docstring).
    if (req.gezelId && req.sessionId) {
      const config = await ctx.store.readConfig();
      if (needsConfirmation(config.videoGenerationConfirmation)) {
        // Name the model the engine will actually load. A passthrough video
        // gezel sends no `model` (it rides the Settings default, which the
        // provider resolves later), so a bare `req.model` would leave the card
        // reading `diffusers-default`. Resolve the effective installed model
        // and prefer its friendly catalog name ("LTX-2.3 …"); fall back to the
        // requested id, then the provider placeholder.
        const modelLabel = chosen?.name ?? req.model?.trim() ?? `${provider.name}-default`;
        const verdict = await awaitVideoApproval(ctx, {
          projectId,
          gezelId: req.gezelId,
          sessionId: req.sessionId,
          provider: provider.name,
          model: modelLabel,
          prompt: req.prompt,
          width: effWidth,
          height: effHeight,
          numFrames: effNumFrames,
          fps: effFps,
          animating: Boolean(resolvedInput),
        });
        if (verdict === 'declined') {
          return c.json({ error: 'User declined this video generation.' }, 403);
        }
        if (verdict === 'timeout') {
          return c.json(
            { error: 'Video-generation approval request timed out. Generation cancelled.' },
            408,
          );
        }
        if (verdict === 'always') {
          await ctx.store.writeConfig({ videoGenerationConfirmation: 'always-allow' });
        }
      }
    }

    // VRAM-tenancy chat event. The local engine is long-running and, in
    // `swap` GPU policy, evicts the chat model for the duration. Mock /
    // future cloud providers skip it (no local GPU contention).
    //
    // Device-level signal — do NOT gate on agent identity (that's only
    // the cost-confirmation gate's concern above). Always publish for the
    // local engine so the always-global engine pill morphs to "Video";
    // the ids ride along when present so the per-session bubble status
    // works too, but their absence no longer hides the pill.
    const swapScope =
      LOCAL_VIDEO_ENGINES.has(provider.name) ||
      (provider instanceof RemoteVideoProvider && provider.onThisComputer)
        ? { sessionId: req.sessionId ?? '', gezelId: req.gezelId ?? '', projectId }
        : undefined;
    // Diagnostic: surfaces WHY the chat bubble may not show phase status.
    // `swap=no` ⇒ cloud/mock provider; `swap=yes` ⇒ local engine, events
    // publish (look for the `status →` lines below to confirm onStatus fires).
    log.info(
      `[video-gen] generate provider=${provider.name} gezelId=${req.gezelId ?? 'NONE'} sessionId=${req.sessionId ?? 'NONE'} swap=${swapScope ? 'yes' : 'no'}`,
    );
    if (swapScope) {
      ctx.chatEvents.publish(swapScope, {
        type: 'gpu_swap',
        state: 'started',
        task: 'video_generation',
        // Short, label-friendly — the provider's onStatus refines this
        // through the warm-up phases (provisioning → loading → generating).
        detail: 'Starting the video engine…',
        prompt: req.prompt,
      });
    }

    try {
      const out = await provider.generate({
        prompt: req.prompt,
        ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
        ...(effectiveModelId ? { model: effectiveModelId } : {}),
        ...(effWidth ? { width: effWidth } : {}),
        ...(effHeight ? { height: effHeight } : {}),
        ...(effNumFrames ? { numFrames: effNumFrames } : {}),
        ...(effFps ? { fps: effFps } : {}),
        ...(effSteps ? { steps: effSteps } : {}),
        ...(effGuidanceScale !== undefined ? { guidanceScale: effGuidanceScale } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(resolvedInput ? { inputImage: resolvedInput } : {}),
        // A caller that hangs up stops the render; the sd.cpp engine cancels its job.
        signal: c.req.raw.signal,
        ...(swapScope
          ? {
              onProgress: (p) => {
                ctx.chatEvents.publish(swapScope, {
                  type: 'gpu_swap',
                  state: 'progress',
                  task: 'video_generation',
                  step: p.step,
                  totalSteps: p.totalSteps,
                  progress: Math.max(0, Math.min(1, p.step / p.totalSteps)),
                  ...(p.secondsPerStep !== undefined ? { secondsPerStep: p.secondsPerStep } : {}),
                  prompt: req.prompt,
                });
              },
              // Warm-up phase text (provisioning / loading model). Published
              // without step counters so the bubble shows the message as its
              // label, then switches to the step bar once sampling begins.
              onStatus: (message) => {
                log.info(`[video-gen] status → ${message}`);
                ctx.chatEvents.publish(swapScope, {
                  type: 'gpu_swap',
                  state: 'progress',
                  task: 'video_generation',
                  detail: message,
                  prompt: req.prompt,
                });
              },
            }
          : {}),
      });
      // sd.cpp writes WebM; this daemon adds an MP4 and a poster when it can.
      const delivered = await deliverVideo({
        video: out.video,
        mimeType: out.meta.mimeType,
        ...(out.poster ? { poster: out.poster } : {}),
      });
      const notes = [...sizing.notes, ...(out.meta.settingsNotes ?? []), ...delivered.notes];
      const stem = artifactStem(out.meta.seed);
      const writtenPath = await ctx.store.writeProjectArtifactBinary(
        projectId,
        `generated/${stem}.${delivered.primary.ext}`,
        delivered.primary.data,
      );
      const alternates: Array<{ artifactPath: string; mimeType: string }> = [];
      for (const alt of delivered.alternates) {
        alternates.push({
          artifactPath: await ctx.store.writeProjectArtifactBinary(
            projectId,
            `generated/${stem}.${alt.ext}`,
            alt.data,
          ),
          mimeType: alt.mimeType,
        });
      }
      const posterPath = delivered.poster
        ? await ctx.store.writeProjectArtifactBinary(
            projectId,
            `generated/${stem}-poster.${delivered.poster.ext}`,
            delivered.poster.data,
          )
        : undefined;

      // Workspace copy with a short, predictable name so HTML the model
      // writes can reference it via `<video src="assets/generated/video-<seed>.<ext>">`.
      const workspace = workspaceCopy(saveAs, out.meta.seed, delivered);
      if (workspace.note) notes.push(workspace.note);
      let workspacePath: string | null = null;
      try {
        await ctx.store.writeProjectWorkspaceBinary(projectId, workspace.path, workspace.file.data);
        workspacePath = workspace.path;
      } catch (err) {
        log.warn(`workspace copy skipped: ${err instanceof Error ? err.message : String(err)}`);
      }

      const meta = {
        ...out.meta,
        mimeType: delivered.primary.mimeType,
        ...(notes.length ? { settingsNotes: notes } : {}),
        ...(i2vSkippedReason ? { i2vSkippedReason } : {}),
      };
      const respBody: {
        artifactPath: string;
        workspacePath: string | null;
        meta: typeof meta;
        b64Poster?: string;
        posterPath?: string;
        posterMimeType?: string;
        alternates?: typeof alternates;
      } = {
        artifactPath: writtenPath,
        workspacePath,
        meta,
        ...(posterPath && delivered.poster
          ? { posterPath, posterMimeType: delivered.poster.mimeType }
          : {}),
        ...(alternates.length ? { alternates } : {}),
      };
      if (req.inline && delivered.poster) {
        respBody.b64Poster = delivered.poster.data.toString('base64');
      }
      return c.json(respBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Expected outcomes carry our own sentence on a 4xx: a 5xx body is
      // replaced with an opaque error (http/errors.ts), and the person needs
      // to hear that a smaller clip would work.
      if (err instanceof VideoCapacityError || err instanceof VideoRenderTimedOutError) {
        return c.json({ error: message, code: err.code }, 409);
      }
      // A caller that hung up never reads this.
      if (err instanceof VideoGenerationCancelledError) {
        return c.json({ error: message, code: err.code }, 504);
      }
      return c.json({ error: message }, 500);
    } finally {
      if (swapScope) {
        ctx.chatEvents.publish(swapScope, {
          type: 'gpu_swap',
          state: 'ended',
          task: 'video_generation',
        });
      }
    }
  });
  app.route('/', videoModelRoutes(ctx));

  return app;
}

function artifactStem(seed: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `video-${stamp}-${seed}`;
}

/**
 * Where the workspace copy goes and which file it is. A `saveAs` names a
 * container; when the clip exists in it, that file is copied, otherwise the
 * primary is copied under the right extension and a note says so.
 */
function workspaceCopy(
  saveAs: string | undefined,
  seed: number,
  delivered: DeliveredVideo,
): { path: string; file: DeliveredFile; note?: string } {
  if (!saveAs) {
    return {
      path: `assets/generated/video-${seed}.${delivered.primary.ext}`,
      file: delivered.primary,
    };
  }
  const wanted = /\.([a-z0-9]+)$/i.exec(saveAs)?.[1]?.toLowerCase();
  const match = [delivered.primary, ...delivered.alternates].find((f) => f.ext === wanted);
  if (match) return { path: saveAs, file: match };
  const path = `${saveAs.replace(/\.[a-z0-9]+$/i, '')}.${delivered.primary.ext}`;
  return {
    path,
    file: delivered.primary,
    note: `Saved as ${path}: no ${wanted ?? 'requested'} version of this clip could be made.`,
  };
}

interface VideoDefaults {
  width?: number;
  height?: number;
  numFrames?: number;
  fps?: number;
  steps?: number;
  guidanceScale?: number;
  /** Catalog geometry: present for catalog models, absent for a paired server's. */
  family?: VideoModelFamily;
  architecture?: VideoArchitecture;
  widthRange?: { min: number; max: number };
  heightRange?: { min: number; max: number };
  numFramesRange?: { min: number; max: number };
  maxDurationSeconds?: number;
}

/**
 * The model a request will run on, by the precedence the engine's
 * `VideoModelSelector` applies at launch: the requested id, else the
 * Settings default when it is installed, else the first installed model.
 * The defaults and the approval card must describe that model — a distilled
 * model handed another model's guidance scale samples with guidance it was
 * never trained for.
 */
export async function resolveEffectiveVideoModelId(
  ctx: Pick<ServiceContext, 'store'>,
  provider: Pick<VideoProvider, 'listInstalledModels'>,
  requestedModel: string | undefined,
  hasSource = false,
  installed?: readonly InstalledVideoModelInfo[],
): Promise<string | undefined> {
  if (requestedModel) return requestedModel;
  const models = installed ?? (await provider.listInstalledModels().catch(() => []));
  const configured = (await ctx.store.readConfig().catch(() => null))?.defaultVideoModel;
  return chooseVideoModel(models, { defaultModelId: configured, hasSource }) ?? models[0]?.id;
}

/** Where a render runs: an engine on this computer (the machine broker counts), or a paired server. */
function videoEnginePlacement(provider: VideoProvider): 'this-computer' | 'paired' {
  return provider instanceof RemoteVideoProvider && !provider.onThisComputer
    ? 'paired'
    : 'this-computer';
}

/**
 * The size and length a request renders at. With the model's catalog facts,
 * sides land on its token grid and frames on its VAE's grid, and a picture
 * to animate sets the shape; a requested value that had to move is noted.
 * Without them (a paired server's model) the request passes through.
 */
function resolveRenderSize(
  req: {
    width?: number;
    height?: number;
    numFrames?: number;
    fps?: number;
    aspectRatio?: ImageAspectRatio;
  },
  defaults: VideoDefaults,
  sourceSize: { width: number; height: number } | undefined,
): { width?: number; height?: number; numFrames?: number; notes: string[] } {
  if (!defaults.family) {
    const width = req.width ?? defaults.width;
    const height = req.height ?? defaults.height;
    const numFrames = req.numFrames ?? defaults.numFrames;
    return {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(numFrames ? { numFrames } : {}),
      notes: [],
    };
  }
  const geo = videoGeometry({ family: defaults.family, architecture: defaults.architecture });
  const size = resolveVideoSize(
    { width: req.width, height: req.height, aspectRatio: req.aspectRatio, sourceSize },
    {
      defaultWidth: defaults.width,
      defaultHeight: defaults.height,
      widthRange: defaults.widthRange,
      heightRange: defaults.heightRange,
    },
    geo,
  );
  const numFrames = resolveVideoFrames(
    req.numFrames,
    {
      defaultNumFrames: defaults.numFrames,
      numFramesRange: defaults.numFramesRange,
      maxDurationSeconds: defaults.maxDurationSeconds,
    },
    req.fps ?? defaults.fps ?? 24,
    geo,
  );
  const notes: string[] = [];
  if (
    (req.width !== undefined && req.width !== size.width) ||
    (req.height !== undefined && req.height !== size.height)
  ) {
    notes.push(`Rendered at ${size.width}×${size.height}, the nearest size this model makes.`);
  }
  if (req.numFrames !== undefined && req.numFrames !== numFrames) {
    notes.push(`Rendered ${numFrames} frames, the nearest length this model makes.`);
  }
  return { ...size, numFrames, notes };
}

/**
 * Pull the model's native generation defaults from the catalog so an
 * omitted request field uses what the model was tuned for (resolution,
 * frame count, fps, steps). Mirrors `resolveRecommendedImageSteps`.
 * Falls back to an empty object (the provider's own generic defaults
 * then apply) when the model isn't a catalog `video-model`.
 */
async function resolveVideoDefaults(
  ctx: Pick<ServiceContext, 'catalog'>,
  modelId: string | undefined,
): Promise<VideoDefaults> {
  if (!modelId) return {};
  const detail = await ctx.catalog.get('video-model', modelId).catch(() => null);
  if (!detail || detail.manifest.kind !== 'video-model') return {};
  const m = detail.manifest;
  return {
    ...(m.defaultWidth !== undefined ? { width: m.defaultWidth } : {}),
    ...(m.defaultHeight !== undefined ? { height: m.defaultHeight } : {}),
    ...(m.defaultNumFrames !== undefined ? { numFrames: m.defaultNumFrames } : {}),
    ...(m.defaultFps !== undefined ? { fps: m.defaultFps } : {}),
    ...(m.recommendedSteps !== undefined ? { steps: m.recommendedSteps } : {}),
    ...(m.guidanceScale !== undefined ? { guidanceScale: m.guidanceScale } : {}),
    family: m.family,
    ...(m.architecture ? { architecture: m.architecture } : {}),
    ...(m.widthRange ? { widthRange: m.widthRange } : {}),
    ...(m.heightRange ? { heightRange: m.heightRange } : {}),
    ...(m.numFramesRange ? { numFramesRange: m.numFramesRange } : {}),
    ...(m.maxDurationSeconds !== undefined ? { maxDurationSeconds: m.maxDurationSeconds } : {}),
  };
}

function needsConfirmation(
  setting: 'always-allow' | 'ask' | { mode: 'snooze'; until: string } | undefined,
): boolean {
  if (setting === undefined) return true;
  if (setting === 'always-allow') return false;
  if (setting === 'ask') return true;
  if (typeof setting === 'object' && setting.mode === 'snooze') {
    const deadline = Date.parse(setting.until);
    if (!Number.isFinite(deadline)) return true;
    return Date.now() >= deadline;
  }
  return true;
}

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const APPROVAL_POLL_MS = 500;

async function awaitVideoApproval(
  ctx: ServiceContext,
  args: {
    projectId: string;
    gezelId: string;
    sessionId: string;
    provider: string;
    model: string;
    prompt: string;
    width?: number;
    height?: number;
    numFrames?: number;
    fps?: number;
    /** The clip animates a picture the caller sent. */
    animating?: boolean;
  },
): Promise<'allow' | 'always' | 'declined' | 'timeout'> {
  const sizeBits: string[] = [];
  if (args.width && args.height) sizeBits.push(`${args.width}×${args.height}`);
  if (args.numFrames) sizeBits.push(`${args.numFrames}f`);
  if (args.fps) sizeBits.push(`${args.fps}fps`);
  const intent: QuestionIntent = {
    kind: 'video-generation-approval',
    provider: args.provider,
    model: args.model,
    promptPreview: truncate(args.prompt, 200),
    ...(sizeBits.length > 0 ? { estimatedSize: sizeBits.join(' · ') } : {}),
  };
  const question: Question = {
    id: randomUUID(),
    projectId: args.projectId,
    gezelId: args.gezelId,
    sessionId: args.sessionId,
    prompt: buildPrompt(args.model, args.prompt, sizeBits.join(' · '), args.animating === true),
    choices: ['Allow once', 'Always allow', 'Decline'],
    allowWriteIn: false,
    multiSelect: false,
    intent,
    createdAt: nowIso(),
  };
  await ctx.store.writeQuestion(question);
  const scope = {
    sessionId: question.sessionId,
    gezelId: question.gezelId,
    projectId: question.projectId,
  };
  ctx.chatEvents.publish(scope, { type: 'question_asked', question });
  ctx.chat.recordSessionIntent(scope, 'awaiting your approval to generate a video');

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await ctx.store.getQuestion(args.projectId, question.id);
    if (current?.answer) {
      const ans = current.answer;
      if (ans.declined) return 'declined';
      const choice = ans.selectedChoices?.[0];
      if (choice === 0) return 'allow';
      if (choice === 1) return 'always';
      return 'declined';
    }
    await sleep(APPROVAL_POLL_MS);
  }
  return 'timeout';
}

function buildPrompt(model: string, prompt: string, size: string, animating: boolean): string {
  const trimmed = truncate(prompt, 200);
  const sizeNote = size ? ` (${size})` : '';
  const what = animating ? 'Animate a picture into a video' : 'Generate a video';
  return `${what} with \`${model}\`${sizeNote}? This is a long, GPU-intensive job that pauses the chat model.\n\n> ${trimmed}`;
}

async function resolveInputImage(
  ctx: ServiceContext,
  projectId: string,
  input: VideoInputSource,
): Promise<VideoInputBytes> {
  if ('artifactPath' in input) {
    const stripped = input.artifactPath.replace(/^artifacts\//, '');
    const found = await ctx.store.readProjectArtifactBinary(projectId, stripped);
    if (!found) {
      throw new Error(`Input image not found at artifacts/${stripped}`);
    }
    return { data: found.data, mimeType: found.mimeType };
  }
  const buf = Buffer.from(input.data, 'base64');
  if (buf.length === 0) {
    throw new Error('Input image base64 decoded to zero bytes.');
  }
  return { data: buf, mimeType: input.mimeType || 'image/png' };
}

function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > n ? `${collapsed.slice(0, n - 1)}…` : collapsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIDEO_EXT_RE = /\.(mp4|webm)$/i;

function validateSaveAs(path: string): string | null {
  if (path.startsWith('/') || path.includes('\\')) {
    return '`saveAs` must be a relative POSIX path (no leading `/`, no backslashes).';
  }
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return '`saveAs` must not contain empty segments, `.`, or `..`.';
  }
  if (!VIDEO_EXT_RE.test(path)) {
    return '`saveAs` must end with `.mp4` or `.webm`.';
  }
  return null;
}
