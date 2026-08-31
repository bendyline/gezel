import {
  type ImageRecognition,
  type MessageImageDigest,
  type ProviderName,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { readImageStaticMeta } from '../index-store/image-meta.js';
import type { RecognitionManager } from '../providers/recognition/manager.js';
import { resolveAutoMode } from '../providers/recognition/prompts.js';
import type { ImageAttachment } from '../providers/types.js';
import { type ResolvedImage, extractResolvedImages } from './image-attachments.js';
import { toMessageDigest } from './recognition-splice.js';
import { type RecognitionMode, resolveImageStrategy } from './vision-capability.js';

const log = createLogger('chat');

/**
 * Decide what happens to the images in this turn, and do it.
 *
 * Extracted out of `ChatManager.send` so the manager stays an orchestrator —
 * the same shape the supervisor branches follow. The whole point is that a
 * pasted screenshot behaves sanely for every engine: models that can see get
 * the pixels, models that can't get a description, and nobody gets silence.
 */

export interface TurnImageLimits {
  maxImagesPerTurn: number;
  /**
   * Hard ceiling for one image, NOT the working budget.
   *
   * The reader streams and is policed by a no-progress watchdog
   * (`RECOGNITION_STREAM_IDLE_MS`), so a wedged engine is caught in ~30s
   * regardless of what this says. This value only bounds a model that keeps
   * producing forever — and when it does bite, the partial transcript is
   * kept rather than discarded.
   *
   * It was 45s, which was shorter than the work it was guarding: `ocr`/`ui`
   * permit 1600 tokens, and a 4B vision model at ~26 tok/s needs ~61s to
   * spend them. Every dense image therefore timed out by construction.
   */
  timeoutMsPerImage: number;
  maxDigestChars: number;
  /**
   * Above this, skip the model. llama.cpp's mtmd tiles a large image into a
   * token explosion, and there is no image resizer in the dependency tree to
   * downscale first — so the honest answer is file details plus a note.
   */
  maxMegapixels: number;
}

export const DEFAULT_TURN_IMAGE_LIMITS: TurnImageLimits = {
  maxImagesPerTurn: 4,
  timeoutMsPerImage: 180_000,
  maxDigestChars: 2000,
  maxMegapixels: 12,
};

export interface ResolveTurnImagesInput {
  store: Store;
  projectId: string;
  sessionId: string;
  markdown: string;
  provider: ProviderName;
  modelId?: string;
  mmprojPath?: string;
  nativeVisionEnabled?: boolean;
  recognition?: RecognitionManager;
  mode: RecognitionMode;
  limits?: Partial<TurnImageLimits>;
  /** Wraps the recognition pass so the bubble narrates instead of going quiet. */
  onRecognitionPhase?: (state: 'started' | 'ended', detail?: string) => void;
}

export interface ResolveTurnImagesResult {
  /** Bytes to ship. Empty unless the model can genuinely decode images. */
  attachments: ImageAttachment[];
  /** Text digests to splice into the turn and persist onto the message. */
  digests: MessageImageDigest[];
  /** Surfaced on the message so the bubble can explain a missing description. */
  warnings: string[];
  verdict: 'native' | 'preprocess' | 'unavailable' | 'none';
  reason: string;
}

const EMPTY: ResolveTurnImagesResult = {
  attachments: [],
  digests: [],
  warnings: [],
  verdict: 'none',
  reason: 'no images in this turn',
};

export async function resolveTurnImages(
  input: ResolveTurnImagesInput,
): Promise<ResolveTurnImagesResult> {
  const limits = { ...DEFAULT_TURN_IMAGE_LIMITS, ...input.limits };

  let images: ResolvedImage[];
  try {
    images = await extractResolvedImages(
      input.store,
      input.projectId,
      input.sessionId,
      input.markdown,
    );
  } catch (err) {
    log.warn('image extraction failed:', err);
    return EMPTY;
  }
  if (images.length === 0) return EMPTY;

  const recognitionAvailable = input.recognition
    ? await input.recognition.isAvailable().catch(() => false)
    : false;
  const plan = resolveImageStrategy(
    {
      provider: input.provider,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.mmprojPath ? { mmprojPath: input.mmprojPath } : {}),
      ...(input.nativeVisionEnabled ? { nativeVisionEnabled: true } : {}),
    },
    { mode: input.mode, recognitionAvailable },
  );

  if (plan.verdict === 'native') {
    log.info(
      `attaching ${images.length} image${images.length === 1 ? '' : 's'} natively — ${plan.reason}`,
    );
    return {
      attachments: images.map((i) => i.attachment),
      digests: [],
      warnings: [],
      verdict: 'native',
      reason: plan.reason,
    };
  }

  // A chat turn is not a batch job. Beyond the cap, the remaining images still
  // get file details so the model knows they exist.
  const described = images.slice(0, limits.maxImagesPerTurn);
  const overflow = images.slice(limits.maxImagesPerTurn);

  const digests: MessageImageDigest[] = [];
  const warnings: string[] = [];
  let announced = false;
  // Images this turn MEANT to read but couldn't. Tracked only over
  // `described` — an overflow image is static-only by design and already
  // has its own warning.
  const unreadable: string[] = [];

  for (const image of described) {
    const meta = readImageStaticMeta(image.bytes);
    const megapixels = meta.width && meta.height ? (meta.width * meta.height) / 1_000_000 : 0;
    const tooLarge = megapixels > limits.maxMegapixels;

    let recognition: ImageRecognition;
    if (plan.verdict === 'unavailable' || tooLarge || !input.recognition) {
      recognition = staticOnly(meta, tooLarge ? `image is ${megapixels.toFixed(0)} MP` : undefined);
    } else {
      if (!announced) {
        input.onRecognitionPhase?.('started');
        announced = true;
      }
      const mode = resolveAutoMode(meta, image.attachment.filename);
      try {
        recognition = await input.recognition.recognize({
          bytes: image.bytes,
          mimeType: image.attachment.mimeType,
          mode,
          timeoutMsOverride: limits.timeoutMsPerImage,
        });
      } catch (err) {
        // Recognition is best-effort. The user's question still goes through.
        log.warn(`recognition threw for ${image.ref}:`, err);
        recognition = staticOnly(meta, err instanceof Error ? err.message : String(err));
      }
    }
    if (recognition.status === 'failed' || recognition.status === 'static-only') {
      unreadable.push(recognition.failureReason ?? 'no description available');
    }
    digests.push(toMessageDigest(image.ref, recognition, { maxChars: limits.maxDigestChars }));
  }

  for (const image of overflow) {
    digests.push(
      toMessageDigest(
        image.ref,
        staticOnly(readImageStaticMeta(image.bytes), 'not read this turn'),
        {
          maxChars: limits.maxDigestChars,
        },
      ),
    );
  }

  if (announced) input.onRecognitionPhase?.('ended');

  if (overflow.length > 0) {
    warnings.push(
      `Only the first ${limits.maxImagesPerTurn} images were read. The rest are listed by their file details.`,
    );
  }
  if (plan.verdict === 'unavailable') {
    warnings.push(
      recognitionAvailable
        ? `This model can't see images, and local image reading is turned off. ${plan.reason}.`
        : "This model can't see images. Install a reader in Settings → Workloads → Image recognition, or switch to a model with vision.",
    );
  } else if (unreadable.length > 0) {
    // The plan promised a local read and the read did not happen — a
    // timed-out reader, an oversized image, a reader that errored. The
    // model IS told per-image (`renderDigestBody` writes "Could not read
    // this image"), but nothing reached the person who attached it: they
    // saw their screenshot go up, assumed the gezel could see it, and got
    // an answer written from the filename and dimensions.
    const scope =
      unreadable.length === described.length
        ? described.length === 1
          ? 'the image'
          : 'any of the images'
        : `${unreadable.length} of ${described.length} images`;
    warnings.push(
      `Couldn't read ${scope} you attached (${unreadable[0]}). The gezel is answering from the file details only — it cannot see the picture.`,
    );
  }

  log.info(
    `${plan.verdict} for ${images.length} image${images.length === 1 ? '' : 's'} — ${plan.reason}`,
  );
  return { attachments: [], digests, warnings, verdict: plan.verdict, reason: plan.reason };
}

function staticOnly(
  meta: ReturnType<typeof readImageStaticMeta>,
  failureReason?: string,
): ImageRecognition {
  return {
    schemaVersion: 1,
    sha256: meta.sha256,
    meta,
    modes: ['describe'],
    engine: 'none',
    modelId: 'none',
    status: 'static-only',
    ...(failureReason ? { failureReason } : {}),
    durationMs: 0,
    at: nowIso(),
  };
}
