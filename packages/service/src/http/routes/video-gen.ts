import { randomUUID } from 'node:crypto';
import {
  type Question,
  type QuestionIntent,
  VideoGenerationRequestSchema,
  type VideoInputSource,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import { UnknownVideoModelError } from '../../providers/video/pull-registry.js';
import type { VideoInputBytes, VideoProvider } from '../../providers/video/types.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('video-gen');

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

    // Resolve an artifact-path input image to bytes before forwarding.
    let resolvedInput: VideoInputBytes | undefined;
    if (req.inputImage) {
      try {
        resolvedInput = await resolveInputImage(ctx, projectId, req.inputImage);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    // Resolve per-model defaults (native resolution / frame count / fps /
    // steps) from the catalog so an omitted field uses the value the
    // model was tuned for — LTX at 704×480, WAN 2.2 TI2V-5B at 1280×704.
    // Generating WAN at LTX's default would produce a wrong-aspect,
    // degraded clip. The caller's explicit value always wins.
    const defaults = await resolveVideoDefaults(ctx, provider, req.model);
    const effWidth = req.width ?? defaults.width;
    const effHeight = req.height ?? defaults.height;
    const effNumFrames = req.numFrames ?? defaults.numFrames;
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
        const installed = await provider.listInstalledModels().catch(() => []);
        const effectiveModel = req.model ? installed.find((m) => m.id === req.model) : installed[0];
        const modelLabel = effectiveModel?.name ?? req.model?.trim() ?? `${provider.name}-default`;
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
      provider.name === 'diffusers'
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
        ...(req.model ? { model: req.model } : {}),
        ...(effWidth ? { width: effWidth } : {}),
        ...(effHeight ? { height: effHeight } : {}),
        ...(effNumFrames ? { numFrames: effNumFrames } : {}),
        ...(effFps ? { fps: effFps } : {}),
        ...(effSteps ? { steps: effSteps } : {}),
        ...(effGuidanceScale !== undefined ? { guidanceScale: effGuidanceScale } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(resolvedInput ? { inputImage: resolvedInput } : {}),
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
      const ext = out.meta.mimeType.includes('webm') ? 'webm' : 'mp4';
      const relPath = `generated/${artifactFilename(out.meta.seed, ext)}`;
      const writtenPath = await ctx.store.writeProjectArtifactBinary(projectId, relPath, out.video);

      // Workspace copy with a short, predictable name so HTML the model
      // writes can reference it via `<video src="assets/generated/video-<seed>.<ext>">`.
      const workspaceRel = saveAs ?? `assets/generated/video-${out.meta.seed}.${ext}`;
      let workspacePath: string | null = null;
      try {
        await ctx.store.writeProjectWorkspaceBinary(projectId, workspaceRel, out.video);
        workspacePath = workspaceRel;
      } catch (err) {
        log.warn(`workspace copy skipped: ${err instanceof Error ? err.message : String(err)}`);
      }

      const respBody: {
        artifactPath: string;
        workspacePath: string | null;
        meta: typeof out.meta;
        b64Poster?: string;
      } = {
        artifactPath: writtenPath,
        workspacePath,
        meta: out.meta,
      };
      if (req.inline && out.poster) respBody.b64Poster = out.poster.toString('base64');
      return c.json(respBody);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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

  app.get('/models', async (c) => {
    const provider = await ctx.videoProvider.current();
    const models = await provider.listInstalledModels();
    const kind = providerKind(provider.name);
    return c.json({ models: models.map((m) => ({ ...m, kind })) });
  });

  app.get('/engine-status', async (c) => {
    const provider = await ctx.videoProvider.current();
    const [engine, models] = await Promise.all([provider.health(), provider.listInstalledModels()]);
    return c.json({
      engine: {
        ...engine,
        kind: providerKind(provider.name),
        provider: provider.name,
      },
      modelCount: models.length,
    });
  });

  app.post('/models/:id/pull', async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.videoPulls.start(id);
    } catch (err) {
      if (err instanceof UnknownVideoModelError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  app.get('/pulls', (c) => {
    return c.json({ pulls: ctx.videoPulls.list() });
  });

  app.get('/pulls/:id/events', (c) => {
    const id = c.req.param('id');
    if (!ctx.videoPulls.get(id)) {
      return c.json({ error: `no active pull for video-model: ${id}` }, 404);
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  app.delete('/pulls/:id', (c) => {
    const id = c.req.param('id');
    const aborted = ctx.videoPulls.cancel(id);
    return c.json({ aborted });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    const provider = await ctx.videoProvider.current();
    await provider.deleteModel(id);
    return c.json({ ok: true as const });
  });

  return app;
}

async function subscribeToPullSse(
  ctx: ServiceContext,
  id: string,
  stream: SSEStreamingApi,
): Promise<void> {
  let done = false;
  const { promise, resolve } = withResolvers<void>();
  const unsubscribe = ctx.videoPulls.subscribe(id, (event) => {
    if (done) return;
    const write = stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    if (event.type === 'done' || event.type === 'error') {
      done = true;
      // Flush the terminal frame BEFORE resolving — resolving lets the
      // streamSSE handler return, which tears down the response. Without
      // awaiting the write, Hono can close the socket before the `done`
      // bytes flush, so the client never receives it and the UI's
      // progress card sits frozen at 100% even though the install
      // finished. (The multi-file verify phase makes the window wide.)
      void write.then(() => resolve());
    }
  });
  if (!unsubscribe) return;
  stream.onAbort(() => {
    if (done) return;
    done = true;
    resolve();
  });
  await promise;
  unsubscribe();
}

function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function artifactFilename(seed: number, ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `video-${stamp}-${seed}.${ext}`;
}

function providerKind(name: string): 'local' | 'cloud' {
  // Only local engines today; the helper mirrors the image route so a
  // future cloud video provider slots in here.
  return name === 'cloud' ? 'cloud' : 'local';
}

interface VideoDefaults {
  width?: number;
  height?: number;
  numFrames?: number;
  fps?: number;
  steps?: number;
  guidanceScale?: number;
}

/**
 * Pull the model's native generation defaults from the catalog so an
 * omitted request field uses what the model was tuned for (resolution,
 * frame count, fps, steps). Mirrors `resolveRecommendedImageSteps`.
 * Falls back to an empty object (the provider's own generic defaults
 * then apply) when the model isn't a catalog `video-model`.
 */
async function resolveVideoDefaults(
  ctx: Pick<ServiceContext, 'catalog' | 'videoProvider'>,
  provider: VideoProvider,
  requestedModel: string | undefined,
): Promise<VideoDefaults> {
  const modelId = requestedModel ?? (await provider.listInstalledModels().catch(() => []))[0]?.id;
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
    prompt: buildPrompt(args.model, args.prompt, sizeBits.join(' · ')),
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

function buildPrompt(model: string, prompt: string, size: string): string {
  const trimmed = truncate(prompt, 200);
  const sizeNote = size ? ` (${size})` : '';
  return `Generate a video with \`${model}\`${sizeNote}? This is a long, GPU-intensive job that pauses the chat model.\n\n> ${trimmed}`;
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
