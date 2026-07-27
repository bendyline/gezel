import type { RecognitionPullSpec } from './types.js';

/**
 * Vision models for the image-recognition workload.
 *
 * Hardcoded rather than routed through `@bendyline/gezel-catalog`, for the
 * reason `whisper-cpp.ts` already documents: a new `CatalogKind` costs a core
 * schema change, a `pnpm gilde:export-schemas` run, a gilde PR, a publish, and
 * a pin bump in two files — and gilde's ajv identity check silently drops
 * items built against a stale generated schema. That round-trip isn't worth
 * paying before the model choice has proven itself.
 *
 * **Promotion trigger: the third model.** One is a constant, two is a default
 * plus a specialist; three is a catalog. (Whisper has three and is still
 * hardcoded — that's the counter-example this rule exists to prevent.)
 *
 * Both entries are Apache-2.0 with first-party GGUF conversions, and both
 * projector architectures are compiled into the pinned llama.cpp build
 * (`PROJECTOR_TYPE_GRANITE4_VISION`, `PROJECTOR_TYPE_QWEN3VL`).
 */

export interface RecognitionCatalogEntry {
  id: string;
  name: string;
  description: string;
  license: string;
  approxSizeBytes: number;
  /** Higher wins when picking a default for a device. */
  recoScore: number;
  /** Rough resident footprint, used for the capacity reservation. */
  residentBytes: number;
  spec: RecognitionPullSpec;
}

const HF = 'https://huggingface.co';

export const RECOGNITION_MODEL_CATALOG: ReadonlyArray<RecognitionCatalogEntry> = [
  {
    id: 'granite-vision-4.1-4b-q4',
    name: 'Granite Vision 4.1 (4B)',
    description:
      "IBM's document-and-chart specialist. Reads screenshots, tables, diagrams, and scanned text. The default for describing images and OCR.",
    license: 'Apache-2.0',
    approxSizeBytes: 2_099_510_240 + 1_162_347_936,
    residentBytes: 4_200_000_000,
    recoScore: 90,
    spec: {
      name: 'Granite Vision 4.1 (4B)',
      files: [
        {
          role: 'weights',
          filename: 'granite-vision-4.1-4b-Q4_K_M.gguf',
          downloadUrl: `${HF}/ibm-granite/granite-vision-4.1-4b-GGUF/resolve/b1fa14294b0f5cac04c43076d1c4574091abf117/granite-vision-4.1-4b-Q4_K_M.gguf`,
          sha256: '973a58c4cfc2b3f58dedc515a89f73c372fe0910da515ecefcebe966131f769f',
          approxSizeBytes: 2_099_510_240,
        },
        {
          // SigLIP-based projectors can't be quantized (tensor dims aren't
          // divisible by 32), so this stays f16 and is over a third of the
          // download. Not a mistake.
          role: 'mmproj',
          filename: 'mmproj-model-f16.gguf',
          downloadUrl: `${HF}/ibm-granite/granite-vision-4.1-4b-GGUF/resolve/b1fa14294b0f5cac04c43076d1c4574091abf117/mmproj-model-f16.gguf`,
          sha256: '573dd2579f6043649299f0b2225000a5691d92f320aabe909fb4c6e75450cad2',
          approxSizeBytes: 1_162_347_936,
        },
      ],
    },
  },
  {
    id: 'nuextract3-q4',
    name: 'NuExtract 3 (4B)',
    description:
      "NuMind's structured-extraction model. Fills a JSON template from an image and converts documents to markdown. Optional — pick it when you mostly extract fields rather than describe scenes.",
    license: 'Apache-2.0',
    approxSizeBytes: 2_708_803_456 + 675_569_184,
    residentBytes: 4_400_000_000,
    recoScore: 40,
    spec: {
      name: 'NuExtract 3 (4B)',
      files: [
        {
          role: 'weights',
          filename: 'NuExtract3-Q4_K_M.gguf',
          downloadUrl: `${HF}/numind/NuExtract3-GGUF/resolve/631a32f126925ea54d031dc1cb23c9208889c529/NuExtract3-Q4_K_M.gguf`,
          sha256: '123abacbcec47f574f5fed8640a650c2092bd7d7207d043148b11056bd5b771f',
          approxSizeBytes: 2_708_803_456,
        },
        {
          role: 'mmproj',
          filename: 'mmproj-NuExtract3-BF16.gguf',
          downloadUrl: `${HF}/numind/NuExtract3-GGUF/resolve/631a32f126925ea54d031dc1cb23c9208889c529/mmproj-NuExtract3-BF16.gguf`,
          sha256: '9a506ce43544691f4f56f1533768f43e1887ef69b8cd74b2e7a46c4d9a155a01',
          approxSizeBytes: 675_569_184,
        },
      ],
    },
  },
];

export const DEFAULT_RECOGNITION_MODEL_ID = 'granite-vision-4.1-4b-q4';

export function findRecognitionCatalogEntry(id: string): RecognitionCatalogEntry | undefined {
  return RECOGNITION_MODEL_CATALOG.find((m) => m.id === id);
}

/** Best entry that fits the given memory budget, or the default when unknown. */
export function recommendedRecognitionModel(totalMemoryBytes?: number): RecognitionCatalogEntry {
  const fits = RECOGNITION_MODEL_CATALOG.filter(
    (m) => !totalMemoryBytes || m.residentBytes <= totalMemoryBytes * 0.5,
  );
  const pool = fits.length > 0 ? fits : RECOGNITION_MODEL_CATALOG;
  return [...pool].sort((a, b) => b.recoScore - a.recoScore)[0]!;
}
