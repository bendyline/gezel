import { randomUUID } from 'node:crypto';
import {
  type ImageAspectRatio,
  ImageGenerationRequestSchema,
  type ImageInputSource,
  type ImageModelManifest,
  type ImageQuality,
  type Question,
  type QuestionIntent,
  capAgentImageSize,
  chooseImageModel,
  createLogger,
  imageModelDefaultSide,
  imagePromptGuide,
  nowIso,
  resolveHarnessToolsConfig,
  resolveImageSize,
} from '@bendyline/gezel';
import { readImageMeta } from '@bendyline/gezel-inference/internal/utils/image-meta';
import { Hono } from 'hono';

import { NoLocalImageModelError } from '../../providers/image/factory.js';
import { sdCppHonorsNegativePrompt } from '../../providers/image/sd-cpp.js';
import {
  type ImageInputBytes,
  type ImageProvider,
  ImageSourceRequiredError,
} from '../../providers/image/types.js';
import { parseRemoteModelId } from '../../providers/remote/model-id.js';
import type { ServiceContext } from '../context.js';
import { imageModelEditFacts, imageModelRoutes, providerKind } from './image-models.js';

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
const HARNESS_LOCAL_IMAGES_ONLY =
  'Gezel makes images for other apps on this computer only, and the selected image engine is a cloud service. Pick an on-device image model in Gezel, or allow any image engine in Settings → Integrations.';

export function imageGenRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

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

    // An outside AI app (a `harness` token) runs only the engines the person
    // allowed it in Settings → Integrations, never asks for a cloud credit
    // (it has no chat to ask in; "any image engine" is that consent), and
    // never writes into the folder it is working in.
    const harness = c.get('auth')?.scopes.includes('harness') === true;
    if (harness) {
      const mode = resolveHarnessToolsConfig(await ctx.store.readConfig()).images;
      if (mode === 'off') {
        return c.json({ error: 'Image generation is turned off for other apps.' }, 403);
      }
      if (mode === 'local' && providerKind(provider.name) === 'cloud') {
        return c.json({ error: HARNESS_LOCAL_IMAGES_ONLY }, 403);
      }
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
    const hasSources = (resolvedInputs?.length ?? 0) > 0;
    if (req.requireEdit && !hasSources) {
      return c.json({ error: 'Attach the picture to change.', code: 'image_source_required' }, 400);
    }

    // The model is decided once, here, so the steps and size below are that
    // model's, and the machine broker or a paired server renders the same one.
    const kind = providerKind(provider.name);
    let model = req.model;
    if (kind === 'local') {
      const choice = await chooseLocalImageModel(provider, req.model, hasSources);
      if (choice.refusal) return c.json(choice.refusal, 400);
      model = choice.model;
      if (req.requireEdit && choice.edits === false) {
        return c.json(
          {
            error:
              'None of the image models on this computer can change a picture. Download one that can, such as Qwen Image Edit or FLUX.2 Klein, in Settings → Image generation.',
            code: 'image_edit_unavailable',
          },
          409,
        );
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
          aspectRatio: req.aspectRatio,
          quality: req.quality,
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
      const manifest =
        providerKind(provider.name) === 'local'
          ? await resolveImageModelManifest(ctx, provider, model)
          : undefined;
      const recommended = manifest?.recommendedSteps;
      const resolvedSteps =
        req.steps !== undefined && req.capStepsAtRecommended && recommended
          ? Math.min(req.steps, recommended)
          : (req.steps ?? recommended);
      const agentCap =
        req.capAgentSize && providerKind(provider.name) === 'local'
          ? capAgentImageSize(req)
          : undefined;
      // An edit keeps its picture's shape unless another is asked.
      const source = resolvedInputs?.[0] ? readImageMeta(resolvedInputs[0].data) : null;
      const size = requestedImageSize(
        {
          ...(agentCap?.request ?? req),
          model,
          ...(source?.width && source.height
            ? { sourceSize: { width: source.width, height: source.height } }
            : {}),
        },
        manifest,
        providerKind(provider.name),
      );
      const out = await provider.generate({
        signal: c.req.raw.signal,
        prompt: req.prompt,
        ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
        ...(model ? { model } : {}),
        ...(size.width ? { width: size.width } : {}),
        ...(size.height ? { height: size.height } : {}),
        ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
        ...(req.quality ? { quality: req.quality } : {}),
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
                // The bubble draws the sampling bar; weight loads, the
                // queue and the tiled decode report their own units.
                if (p.phase && p.phase !== 'sampling') return;
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
      // `<img>` ref. Cloud providers do not return a seed, so give their
      // copies a short unique suffix to avoid overwriting earlier images.
      const workspaceSuffix =
        providerKind(provider.name) === 'cloud' ? randomUUID().slice(0, 8) : out.meta.seed;
      const workspaceRel = saveAs ?? `assets/generated/image-${workspaceSuffix}.png`;
      let workspacePath: string | null = null;
      try {
        if (!harness) {
          await ctx.store.writeProjectWorkspaceBinary(projectId, workspaceRel, out.png);
          workspacePath = workspaceRel;
        }
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
        promptGuide?: string;
      } = {
        artifactPath: writtenPath,
        workspacePath,
        meta: agentCap?.note
          ? { ...out.meta, settingsNotes: [agentCap.note, ...(out.meta.settingsNotes ?? [])] }
          : out.meta,
      };
      if (req.inline) respBody.b64Png = out.png.toString('base64');
      const promptGuide = renderedModelPromptGuide(
        providerKind(provider.name),
        manifest,
        out.meta.model,
      );
      if (promptGuide) respBody.promptGuide = promptGuide;
      return c.json(respBody);
    } catch (err) {
      if (err instanceof NoLocalImageModelError) {
        return c.json({ error: 'no_local_image_model', hint: err.message }, 409);
      }
      if (err instanceof ImageSourceRequiredError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
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
  app.route('/', imageModelRoutes(ctx));

  return app;
}

function artifactFilename(seed: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `image-${stamp}-${seed}.png`;
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
    width?: number | undefined;
    height?: number | undefined;
    aspectRatio?: ImageAspectRatio | undefined;
    quality?: ImageQuality | undefined;
    inputImageCount: number;
  },
): Promise<'allow' | 'always' | 'declined' | 'timeout'> {
  const size =
    args.width && args.height
      ? `${args.width}×${args.height}`
      : [args.aspectRatio, args.quality].filter(Boolean).join(' · ');
  const intent: QuestionIntent = {
    kind: 'image-generation-approval',
    provider: args.provider,
    model: args.model,
    promptPreview: truncate(args.prompt, 200),
    ...(size ? { estimatedSize: size } : {}),
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
  if (provider === 'copilot') return 'GitHub Copilot';
  if (provider === 'codex-cli') return 'OpenAI Codex';
  return provider;
}

export async function resolveRecommendedImageSteps(
  ctx: Pick<ServiceContext, 'catalog'>,
  provider: Pick<ImageProvider, 'listInstalledModels' | 'resolveDefaultModelId'>,
  requestedModel: string | undefined,
): Promise<number | undefined> {
  return (await resolveImageModelManifest(ctx, provider, requestedModel))?.recommendedSteps;
}

/**
 * The local model a request renders with (core `chooseImageModel`) and
 * whether it can use the sources: unknown when the engine does not list it
 * (nothing installed, where the engine says what to download). A model made
 * only for editing is refused a request with nothing to edit, named or not,
 * before its engine loads.
 */
export async function chooseLocalImageModel(
  provider: Pick<ImageProvider, 'listInstalledModels' | 'resolveDefaultModelId'>,
  requestedModel: string | undefined,
  hasSources: boolean,
): Promise<{
  model?: string;
  edits?: boolean;
  refusal?: { error: string; code: 'image_source_required' };
}> {
  const installed = await provider.listInstalledModels().catch(() => []);
  const models = installed.map((m) => ({ ...m, ...imageModelEditFacts('local', m) }));
  const model =
    requestedModel ??
    chooseImageModel(models, {
      defaultModelId: await provider.resolveDefaultModelId?.().catch(() => undefined),
      hasSources,
    });
  const bare = model ? (parseRemoteModelId(model)?.modelId ?? model) : undefined;
  const chosen = models.find((m) => m.id === bare);
  const blocker = hasSources
    ? undefined
    : chosen?.editOnly
      ? chosen
      : model === undefined
        ? models.find((m) => m.editOnly)
        : undefined;
  if (blocker) {
    return {
      refusal: {
        error: new ImageSourceRequiredError(blocker.name).message,
        code: 'image_source_required',
      },
    };
  }
  return {
    ...(model ? { model } : {}),
    ...(chosen ? { edits: chosen.editMode !== undefined } : {}),
  };
}

/** The catalog entry of the model this request will run, when the catalog lists it. */
export async function resolveImageModelManifest(
  ctx: Pick<ServiceContext, 'catalog'>,
  provider: Pick<ImageProvider, 'listInstalledModels' | 'resolveDefaultModelId'>,
  requestedModel: string | undefined,
): Promise<ImageModelManifest | undefined> {
  // The steps must be the ones of the model the provider will run. The first
  // installed model is not that model once a default is configured: a MOSS
  // default would render at Animagine's 28 steps whenever Animagine sorted
  // first.
  const requested = requestedModel
    ? (parseRemoteModelId(requestedModel)?.modelId ?? requestedModel)
    : undefined;
  const modelId =
    requested ??
    (provider.resolveDefaultModelId
      ? await provider.resolveDefaultModelId().catch(() => undefined)
      : (await provider.listInstalledModels().catch(() => []))[0]?.id);
  if (!modelId) return undefined;
  const detail = await ctx.catalog.get('image-model', modelId).catch(() => null);
  if (!detail || detail.manifest.kind !== 'image-model') return undefined;
  return detail.manifest;
}

/**
 * How the model that just rendered reads a prompt. A local model's traits
 * come from its catalog entry, and the engine's guidance scale decides
 * whether it reads a negative prompt. The cloud APIs read sentences, letter
 * text, and take no negative prompt at all.
 */
export function renderedModelPromptGuide(
  kind: 'local' | 'cloud',
  manifest: Pick<ImageModelManifest, 'id' | 'name' | 'promptStyle' | 'rendersText'> | undefined,
  renderedModel: string,
): string | undefined {
  if (kind === 'cloud') {
    return imagePromptGuide({
      name: renderedModel,
      promptStyle: 'sentences',
      rendersText: true,
      negativePromptHonored: false,
    });
  }
  if (!manifest) return undefined;
  return imagePromptGuide({
    name: manifest.name,
    promptStyle: manifest.promptStyle,
    rendersText: manifest.rendersText,
    negativePromptHonored: sdCppHonorsNegativePrompt(manifest.id),
  });
}

/**
 * The pixels a local engine renders, resolved here so the machine broker and
 * a paired server receive the same size the person's settings describe. With
 * a catalog entry the size always resolves, inside the model's range. A cloud
 * provider gets only what was asked: it maps `aspectRatio` and `quality` to
 * its own sizes.
 */
export function requestedImageSize(
  req: {
    model?: string | undefined;
    width?: number | undefined;
    height?: number | undefined;
    aspectRatio?: ImageAspectRatio | undefined;
    quality?: ImageQuality | undefined;
    sourceSize?: { width: number; height: number } | undefined;
  },
  manifest: Pick<ImageModelManifest, 'id' | 'widthRange' | 'heightRange'> | undefined,
  kind: 'local' | 'cloud',
): { width?: number; height?: number } {
  if (manifest) {
    return resolveImageSize(req, {
      defaultSidePx: imageModelDefaultSide(manifest.id),
      widthRange: manifest.widthRange,
      heightRange: manifest.heightRange,
    });
  }
  if (kind === 'local' && (req.aspectRatio || req.quality || req.sourceSize)) {
    const modelId = req.model ? (parseRemoteModelId(req.model)?.modelId ?? req.model) : undefined;
    return resolveImageSize(req, { defaultSidePx: imageModelDefaultSide(modelId) });
  }
  return {
    ...(req.width ? { width: req.width } : {}),
    ...(req.height ? { height: req.height } : {}),
  };
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
