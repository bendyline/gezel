import { type GezelConfig, createLogger } from '@bendyline/gezel';
import { checkDiskSpace } from '../../utils/disk-space.js';
import type { LlamaCppModelManager } from '../llama-cpp/models.js';
import { type RecognitionCatalogEntry, recommendedRecognitionModel } from './catalog.js';
import { recognitionModelsRoot } from './factory.js';
import type { RecognitionManager } from './manager.js';

const log = createLogger('recognition');

/**
 * Should installing this chat model also pull an image reader?
 *
 * A model that can't see images is the common case, and a user who installs
 * one and then pastes a screenshot gets nothing useful without a reader. So
 * the reader comes along automatically — but only when it would actually
 * change the outcome, and never silently: the pull rides the same progress
 * stream the user is already watching for the chat model.
 *
 * Deliberately conservative about when it fires. Every `null` below is a case
 * where the download would be waste.
 */

export interface AutoInstallDecision {
  entry: RecognitionCatalogEntry;
  reason: string;
}

export interface AutoInstallInput {
  home: string;
  config: GezelConfig;
  /** Catalog id of the chat model that just finished installing. */
  catalogId: string;
  llamaCppModels?: LlamaCppModelManager;
  recognition?: RecognitionManager;
  totalMemoryBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function decideAutoInstall(
  input: AutoInstallInput,
): Promise<AutoInstallDecision | null> {
  const env = input.env ?? process.env;
  if (env.GEZEL_NO_AUTO_VISION === '1') return null;
  if (env.GEZEL_MOCK_PROVIDER === '1') return null;
  if (input.config.recognition?.mode === 'off') return null;
  if (!input.recognition) return null;

  // Already have a reader — nothing to do.
  try {
    const provider = await input.recognition.current();
    const installed = await provider.listInstalledModels();
    if (installed.length > 0) return null;
  } catch {
    return null;
  }

  // The chat model can see for itself: no reader needed.
  if (input.llamaCppModels) {
    try {
      const resolved = await input.llamaCppModels.resolveModel(input.catalogId);
      const nativeOn = input.config.nativeVision?.[input.catalogId] === true;
      if (resolved?.mmprojPath && nativeOn) return null;
    } catch {
      /* fall through — an unresolvable model just means we can't rule it out */
    }
  }

  const entry = recommendedRecognitionModel(input.totalMemoryBytes);

  // Don't wedge the machine. A refused download here is strictly better than
  // filling the disk right after a multi-gigabyte chat-model install.
  // `ok` stays true when the filesystem can't be measured, by design — an
  // unmeasurable disk must not be treated as a full one.
  const space = await checkDiskSpace(recognitionModelsRoot(input.home), entry.approxSizeBytes);
  if (!space.ok) {
    log.info(
      `skipping automatic image-reader install — ${entry.id} needs ${entry.approxSizeBytes} bytes, ${space.freeBytes} free`,
    );
    return null;
  }

  return { entry, reason: `${input.catalogId} cannot read images on its own` };
}
