import { randomUUID } from 'node:crypto';
import {
  ImageGenerationRequestSchema,
  type ImageInputSource,
  type Question,
  type QuestionIntent,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import {
  INVALID_MODEL_ID_CODE,
  INVALID_MODEL_ID_MESSAGE,
  isSafeModelId,
} from '../../models/model-id.js';
import { resolveImg2ImgSupport } from '../../providers/image/img2img-support.js';
import { UnknownImageModelError } from '../../providers/image/pull-registry.js';
import type { ImageInputBytes, ImageProvider } from '../../providers/image/types.js';
import type { ServiceContext } from '../context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

const log = createLogger('image-gen');

/**
 * Image-generation endpoints. Mounted at `/api/image-gen`.
 *
 * Distinct from `/api/projects/:pid/sessions/:sid/images` (which handles
 * pasted image attachments in chat) — this surface drives the
 * configured image-generation engine (local stable-diffusion.cpp by
 * default; optionally Google AI Studio Nano Banana 2 or OpenAI GPT
 * Image 2 as cloud providers).
 */
export function imageGenRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  // Generation remains on the user daemon so project inputs/artifacts never
  // cross the machine data boundary. The provider itself delegates native
  // work to the broker. Model lifecycle/status routes proxy only while the
  // effective provider is native; cloud providers and their credentials stay
  // wholly in the user daemon.
  app.use(
    '*',
    machineEngineProxy(
      ctx,
      '/api/image-gen',
      '/v1/remote/manage/image-gen',
      ['/api/image-gen/generate'],
      () => ctx.imageProvider.usesMachineEngine(),
    ),
  );

  /**
   * Generate an image. The PNG is written into the project's artifacts
   * tree under `generated/` and the response carries the relative path
   * plus generation metadata. Callers (UI, MCP `generate_image`) can
   * render the artifact inline via the existing artifact-serving route.
   *
   * Cloud providers (`google-ai`, `openai`) consult
   * `config.imageGenerationConfirmation` before generating: when the
   * setting is `'ask'` (or undefined) AND the request supplies a
   * `gezelId`+`sessionId` (i.e. the call is agent-driven), we
   * synthesize an `image-generation-approval` question and block via
   * long-poll until the user picks Allow once / Always allow / Decline.
   */
  app.post('/generate', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ImageGenerationRequestSchema.safeParse(body);
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

    let provider: ImageProvider;
    try {
      // Route explicit `remote:<id>/…` models to the paired server. Otherwise
      // use the configured provider; native sd-cpp delegates to the machine
      // broker while user-configured cloud providers stay here.
      provider = await ctx.imageProvider.providerForModel(req.model);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    // Resolve any artifact-path entries in `inputImages` to raw bytes
    // before forwarding to the provider. base64 entries pass through
    // after a single decode. Done here (not in each provider) because
    // the artifact tree is project-scoped state the provider layer
    // shouldn't have to know about.
    let resolvedInputs: ImageInputBytes[] | undefined;
    if (req.inputImages && req.inputImages.length > 0) {
      try {
        resolvedInputs = await resolveInputImages(ctx, projectId, req.inputImages);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    if (providerKind(provider.name) === 'cloud' && req.gezelId && req.sessionId) {
      const config = await ctx.store.readConfig();
      if (needsConfirmation(config.imageGenerationConfirmation)) {
        const verdict = await awaitImageApproval(ctx, {
          projectId,
          gezelId: req.gezelId,
          sessionId: req.sessionId,
          provider: provider.name,
          model: req.model?.trim() || `${provider.name}-default`,
          prompt: req.prompt,
          width: req.width,
          height: req.height,
          inputImageCount: resolvedInputs?.length ?? 0,
        });
        if (verdict === 'declined') {
          return c.json({ error: 'User declined to use a credit on this image generation.' }, 403);
        }
        if (verdict === 'timeout') {
          return c.json(
            {
              error:
                'Image-generation approval request timed out without a user response. Generation cancelled.',
            },
            408,
          );
        }
        if (verdict === 'always') {
          await ctx.store.writeConfig({ imageGenerationConfirmation: 'always-allow' });
        }
      }
    }

    // VRAM-tenancy chat event. Local sd-cpp can take 10–60s on a
    // cold start AND, in `swap` GPU policy, evicts the chat model
    // from VRAM for the duration. Without this signal the bubble
    // would just say "thinking" the whole time, which is actively
    // wrong — the LLM is paused (or evicted), and sd-server is the
    // one doing the work. The UI consumes the paired started/ended
    // events to render a distinct "Generating image…" status and
    // suppress the silence-watchdog reassurance banner.
    //
    // Cloud providers (google-ai, openai) skip this — those are
    // network-bound and don't contend for local GPU.
    //
    // This is a DEVICE-level signal (the sd-cpp engine is holding the
    // GPU), so it must NOT be gated on agent identity the way the cloud
    // cost-confirmation gate above is. Earlier the scope required
    // `gezelId && sessionId`, which silently suppressed the engine pill
    // + "Generating image" bubble status for any local call that didn't
    // carry both ids. Always publish for sd-cpp; the ids ride along when
    // present so the per-session chat bubble still gets it, but their
    // absence no longer hides the always-global engine pill.
    const swapScope =
      provider.name === 'sd-cpp'
        ? { sessionId: req.sessionId ?? '', gezelId: req.gezelId ?? '', projectId }
        : undefined;
    if (swapScope) {
      ctx.chatEvents.publish(swapScope, {
        type: 'gpu_swap',
        state: 'started',
        task: 'image_generation',
        detail: 'Generating image — chat model is paused while sd-cpp uses the GPU',
        prompt: req.prompt,
      });
    }

    try {
      const resolvedSteps =
        req.steps ?? (await resolveRecommendedImageSteps(ctx, provider, req.model));
      const out = await provider.generate({
        prompt: req.prompt,
        ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.width ? { width: req.width } : {}),
        ...(req.height ? { height: req.height } : {}),
        ...(resolvedSteps ? { steps: resolvedSteps } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(resolvedInputs && resolvedInputs.length > 0 ? { inputImages: resolvedInputs } : {}),
        ...(req.strength !== undefined ? { strength: req.strength } : {}),
        // Forward sd-server's per-step sampling progress to the live
        // chat bubble. The provider parses lines like `|==> | 3/20 -
        // 18.20s/it` and invokes this for each step; cloud providers
        // ignore the field (no streaming step counter on their APIs).
        ...(swapScope
          ? {
              onProgress: (p) => {
                ctx.chatEvents.publish(swapScope, {
                  type: 'gpu_swap',
                  state: 'progress',
                  task: 'image_generation',
                  step: p.step,
                  totalSteps: p.totalSteps,
                  progress: Math.max(0, Math.min(1, p.step / p.totalSteps)),
                  ...(p.secondsPerStep !== undefined ? { secondsPerStep: p.secondsPerStep } : {}),
                  prompt: req.prompt,
                });
              },
            }
          : {}),
      });
      const filename = artifactFilename(out.meta.seed);
      const relPath = `generated/${filename}`;
      const writtenPath = await ctx.store.writeProjectArtifactBinary(projectId, relPath, out.png);
      // Also drop a copy into the project workspace so any HTML/CSS the
      // developer is writing can reference it via a normal relative
      // path (`assets/generated/<file>.png`). Without this copy the
      // model writes <img src="artifacts/generated/X.png"> from
      // workspace/index.html, which resolves to a broken path when the
      // file is opened in a browser. The artifacts copy stays as the
      // canonical audit trail; the workspace copy is for live
      // referencing.
      //
      // The workspace copy uses a SHORT, predictable name (`image-<seed>.png`)
      // — distinct from the artifact's timestamped filename. Small models
      // can't reliably echo a 32-char timestamped path back into HTML;
      // they'll invent a clean name like `logo.png` and produce a broken
      // `<img>` ref. The seed-only name is unique within a session and
      // short enough that the model copies it verbatim.
      const workspaceRel = saveAs ?? `assets/generated/image-${out.meta.seed}.png`;
      let workspacePath: string | null = null;
      try {
        await ctx.store.writeProjectWorkspaceBinary(projectId, workspaceRel, out.png);
        workspacePath = workspaceRel;
      } catch (err) {
        // Workspace writes can be denied for legitimate reasons (e.g.
        // an external workingDir the user hasn't approved). Don't fail
        // the whole generation — surface the artifact and note the
        // skip in the response so callers can decide whether to copy
        // the file in themselves.
        log.warn(`workspace copy skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Inline body when the caller asks for it (MCP `generate_image`
      // tool sets this so the chat bubble can render a thumbnail
      // through the same persister + ToolCallImage pipeline that
      // Playwright screenshots use). Direct UI callers leave it false
      // to keep the response small.
      const respBody: {
        artifactPath: string;
        workspacePath: string | null;
        meta: typeof out.meta;
        b64Png?: string;
      } = {
        artifactPath: writtenPath,
        workspacePath,
        meta: out.meta,
      };
      if (req.inline) respBody.b64Png = out.png.toString('base64');
      return c.json(respBody);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      if (swapScope) {
        ctx.chatEvents.publish(swapScope, {
          type: 'gpu_swap',
          state: 'ended',
          task: 'image_generation',
        });
      }
    }
  });

  /** List installed image models (not the catalog — installed weights on disk). */
  app.get('/models', async (c) => {
    const provider = await ctx.imageProvider.current();
    const models = await provider.listInstalledModels();
    const kind = providerKind(provider.name);
    // Cloud image APIs are all edit-capable; local models resolve through
    // the explicit-field → assessment-map → weights-kind ladder so the UI
    // and MCP callers can tell which installed models can edit an image.
    return c.json({
      models: models.map((m) => ({
        ...m,
        kind,
        supportsImg2Img:
          kind === 'cloud'
            ? true
            : resolveImg2ImgSupport({
                modelId: m.id,
                explicit: m.supportsImg2Img,
                weightsKind: m.weightsKind,
              }).supported,
      })),
    });
  });

  /**
   * Engine readiness probe + installed model count, in one round-trip.
   * The Settings UI uses this to render an honest "Ready" pill: "Ready"
   * means the engine is reachable AND at least one model is installed.
   * The distinction between `unreachable` and `not-configured` lets the
   * UI surface different guidance: "set GEZEL_SD_SERVER_URL" vs "your
   * sd-server isn't responding". `kind` and `provider` are injected at
   * the route layer so the UI can branch (cloud → hide pull/delete).
   */
  app.get('/engine-status', async (c) => {
    const provider = await ctx.imageProvider.current();
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

  /**
   * Pull a catalog-resolved image model. `:id` must name an
   * `image-model` catalog entry; the manifest supplies downloadUrl +
   * sha256 + size. Cloud providers reject pull entirely.
   *
   * Backed by {@link ctx.imagePulls} — the registry owns the lifecycle
   * of the actual download so it survives the user navigating away from
   * Settings → Image generation. This SSE is just a subscriber: when
   * the client disconnects, the listener is detached but the pull
   * continues. Use `DELETE /pulls/:id` to actually abort. Idempotent —
   * a second `POST` for the same id while one is in flight returns the
   * same in-flight pull rather than starting a parallel one.
   */
  app.post('/models/:id/pull', async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.imagePulls.start(id);
    } catch (err) {
      if (err instanceof UnknownImageModelError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  /**
   * Snapshot list of every in-flight (or recently-finished) pull. The
   * UI calls this on `ImageModelManager` mount so a returning user sees
   * an accurate progress bar without having to be the original kicker
   * of the pull. Finished pulls hang around briefly so the call
   * captures the terminal state.
   */
  app.get('/pulls', (c) => {
    return c.json({ pulls: ctx.imagePulls.list() });
  });

  /**
   * Subscribe to live events for an in-progress pull. The registry
   * replays the latest snapshot as a synthetic `progress` (and
   * `retrying` / `error` when applicable) on subscribe so the UI never
   * sees an empty bar while waiting for the next real event.
   *
   * Returns 404 when no pull exists for `:id` — the caller should fall
   * back to `POST /models/:id/pull` to start a new one.
   */
  app.get('/pulls/:id/events', (c) => {
    const id = c.req.param('id');
    if (!ctx.imagePulls.get(id)) {
      return c.json({ error: `no active pull for image-model: ${id}` }, 404);
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  /** Explicitly cancel an in-flight pull. Disconnect alone does not cancel. */
  app.delete('/pulls/:id', (c) => {
    const id = c.req.param('id');
    const aborted = ctx.imagePulls.cancel(id);
    return c.json({ aborted });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    if (!isSafeModelId(id)) {
      return c.json({ error: INVALID_MODEL_ID_MESSAGE, code: INVALID_MODEL_ID_CODE }, 400);
    }
    const provider = await ctx.imageProvider.current();
    await provider.deleteModel(id);
    return c.json({ ok: true as const });
  });

  return app;
}

/**
 * Subscribe to the pull registry for `id` and stream its events as SSE.
 * Shared between `POST /models/:id/pull` (start-or-attach) and `GET
 * /pulls/:id/events` (attach-only). Unsubscribes on client disconnect
 * WITHOUT cancelling the pull — that's the whole point of the registry
 * design. The stream terminates after the terminal event so the client
 * loop exits cleanly; the snapshot stays in the registry for the
 * finished-pull TTL so a reconnecting client still sees the result.
 */
async function subscribeToPullSse(
  ctx: ServiceContext,
  id: string,
  stream: SSEStreamingApi,
): Promise<void> {
  let done = false;
  const { promise, resolve } = withResolvers<void>();
  const unsubscribe = ctx.imagePulls.subscribe(id, (event) => {
    if (done) return;
    // A failed write means the socket is gone, which onAbort will also
    // fire — no need to surface it here.
    const write = stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    if (event.type === 'done' || event.type === 'error') {
      done = true;
      // Flush the terminal frame before resolving — resolving lets the
      // handler return and Hono close the response; without the await
      // the `done` bytes can be dropped and the UI's progress card stays
      // stuck at 100%.
      void write.then(() => resolve());
    }
  });
  if (!unsubscribe) {
    // Pull vanished between the route's existence check and the
    // subscribe — treat as a clean terminal so the client moves on.
    return;
  }
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

function artifactFilename(seed: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `image-${stamp}-${seed}.png`;
}

function providerKind(name: string): 'local' | 'cloud' {
  return name === 'google-ai' || name === 'openai' ? 'cloud' : 'local';
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

async function awaitImageApproval(
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
    inputImageCount: number;
  },
): Promise<'allow' | 'always' | 'declined' | 'timeout'> {
  const intent: QuestionIntent = {
    kind: 'image-generation-approval',
    provider: args.provider,
    model: args.model,
    promptPreview: truncate(args.prompt, 200),
    ...(args.width && args.height ? { estimatedSize: `${args.width}×${args.height}` } : {}),
  };
  const question: Question = {
    id: randomUUID(),
    projectId: args.projectId,
    gezelId: args.gezelId,
    sessionId: args.sessionId,
    prompt: buildPrompt(args.provider, args.model, args.prompt, args.inputImageCount),
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
  ctx.chat.recordSessionIntent(
    scope,
    `awaiting your approval to use ${args.provider} for image generation`,
  );

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

function buildPrompt(
  provider: string,
  model: string,
  prompt: string,
  inputImageCount: number,
): string {
  const friendly = providerLabel(provider);
  const trimmed = truncate(prompt, 200);
  const action =
    inputImageCount > 0
      ? `edit ${inputImageCount} reference image${inputImageCount === 1 ? '' : 's'}`
      : 'generate an image';
  return `**${friendly}** is about to ${action} (model \`${model}\`). Use a credit?\n\n> ${trimmed}`;
}

async function resolveInputImages(
  ctx: ServiceContext,
  projectId: string,
  inputs: ImageInputSource[],
): Promise<ImageInputBytes[]> {
  const out: ImageInputBytes[] = [];
  for (const entry of inputs) {
    if ('artifactPath' in entry) {
      const stripped = entry.artifactPath.replace(/^artifacts\//, '');
      const found = await ctx.store.readProjectArtifactBinary(projectId, stripped);
      if (!found) {
        throw new Error(`Input image not found at artifacts/${stripped}`);
      }
      out.push({ data: found.data, mimeType: found.mimeType });
    } else {
      const buf = Buffer.from(entry.data, 'base64');
      if (buf.length === 0) {
        throw new Error('Input image base64 decoded to zero bytes.');
      }
      out.push({ data: buf, mimeType: entry.mimeType || 'image/png' });
    }
  }
  return out;
}

function providerLabel(provider: string): string {
  if (provider === 'google-ai') return 'Google Nano Banana';
  if (provider === 'openai') return 'OpenAI GPT Image';
  return provider;
}

export async function resolveRecommendedImageSteps(
  ctx: Pick<ServiceContext, 'catalog'>,
  provider: Pick<ImageProvider, 'listInstalledModels'>,
  requestedModel: string | undefined,
): Promise<number | undefined> {
  const modelId = requestedModel ?? (await provider.listInstalledModels().catch(() => []))[0]?.id;
  if (!modelId) return undefined;
  const detail = await ctx.catalog.get('image-model', modelId).catch(() => null);
  if (!detail || detail.manifest.kind !== 'image-model') return undefined;
  return detail.manifest.recommendedSteps;
}

function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > n ? `${collapsed.slice(0, n - 1)}…` : collapsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

function validateSaveAs(path: string): string | null {
  if (path.startsWith('/') || path.includes('\\')) {
    return '`saveAs` must be a relative POSIX path (no leading `/`, no backslashes).';
  }
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return '`saveAs` must not contain empty segments, `.`, or `..`.';
  }
  if (!IMAGE_EXT_RE.test(path)) {
    return '`saveAs` must end with `.png`, `.jpg`, `.jpeg`, or `.webp`.';
  }
  return null;
}
