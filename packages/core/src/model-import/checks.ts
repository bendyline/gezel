/**
 * The checks a model from outside the catalog must pass before Gezel will
 * download it. Every catalog model was tried by a person before it shipped;
 * an imported one was not, so the review answers the questions that person
 * would have: can we fetch it, verify it, load it, talk to it, and fit it?
 *
 * Pure: every verdict comes from plain evidence, so the whole matrix is unit
 * tested without a network or an engine. After download the fitness probe
 * (service `fitness/`) answers the questions only a running model can.
 */

import type { ModelFitResult } from '../model-fit.js';
import { LLAMA_CPP_GGUF_SUPPORT_TAG } from '../native/llama-cpp-gguf-support.js';
import { MLX_VLM_SUPPORT_VERSION } from '../native/mlx-model-support.js';
import type { ModelImportCheck, ModelImportCheckStatus } from '../schemas/model-import.js';
import {
  type GgufHeaderFacts,
  chatTemplateSupportsTools,
  ggufNonChatKind,
  ggufTensorTypeNames,
  isSupportedGgufArchitecture,
  unreadableGgufTensorTypes,
} from './gguf-header.js';
import { type MlxConfigFacts, isSupportedMlxModelType } from './mlx.js';

/**
 * The working window agentic tool loops need: the system prompt and tool list
 * run 4-8K tokens before the first question. The fitness probe's own floor.
 */
export const FITNESS_CONTEXT_FLOOR_TOKENS = 16_384;

type HubAccess = {
  /** Hub `gated`: false, or how access is granted. */
  gated: false | 'auto' | 'manual';
  private: boolean;
  disabled: boolean;
  /** A Hugging Face token is configured for downloads. */
  hasToken: boolean;
};

export interface ModelImportEvidence {
  /** The Hub repo's access rules; absent for a file from this computer. */
  access?: {
    /** Hub `gated`: false, or how access is granted. */
    gated: false | 'auto' | 'manual';
    private: boolean;
    disabled: boolean;
    /** A Hugging Face token is configured for downloads. */
    hasToken: boolean;
  };
  /** Absent when the header could not be read; see `headerError`. */
  header?: GgufHeaderFacts;
  headerError?: string;
  /**
   * Every file has a SHA-256: published by the Hub, or for a file from this
   * computer, recorded by Gezel as it arrived.
   */
  allFilesHashed: boolean;
  /** The model is a file from this computer, copied in rather than downloaded. */
  localFile?: boolean;
  /** Fit against this machine; absent when its memory is unknown. */
  fit?: Pick<ModelFitResult, 'tier' | 'label' | 'detail' | 'runnable'>;
  /** `neededBytes` is the download plus the installer's safety margin. */
  disk?: { ok: boolean; downloadBytes: number; neededBytes: number; freeBytes?: number };
  /** Why the active llama.cpp backend should not run this file (NVFP4 on Metal). */
  backendGap?: string;
}

function check(
  id: ModelImportCheck['id'],
  status: ModelImportCheckStatus,
  title: string,
  detail: string,
): ModelImportCheck {
  return { id, status, title, detail };
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function accessCheck(access: HubAccess): ModelImportCheck {
  const title = 'Download access';
  if (access.disabled) {
    return check('access', 'fail', title, 'Hugging Face has disabled this model.');
  }
  if (access.private) {
    return check('access', 'fail', title, 'This model is private on Hugging Face.');
  }
  if (access.gated) {
    return access.hasToken
      ? check(
          'access',
          'warn',
          title,
          'The author asks people to accept their terms on Hugging Face first. The download works only if the account behind your Hugging Face token has accepted them.',
        )
      : check(
          'access',
          'fail',
          title,
          "The author asks people to accept their terms on Hugging Face before downloading, and Gezel downloads without signing in, so it can't fetch this model.",
        );
  }
  return check('access', 'pass', title, 'Anyone can download it.');
}

function integrityCheck(allFilesHashed: boolean, localFile?: boolean): ModelImportCheck {
  if (localFile) {
    return check(
      'integrity',
      'pass',
      'Checksums',
      'Gezel recorded a checksum of each file as it arrived, so it can tell if one changes later.',
    );
  }
  return allFilesHashed
    ? check(
        'integrity',
        'pass',
        'Checksums',
        'Hugging Face publishes a checksum for every file, and Gezel checks each download against it.',
      )
    : check(
        'integrity',
        'fail',
        'Checksums',
        "Hugging Face publishes no checksum for some of these files, so Gezel can't verify the download.",
      );
}

function kindCheck(header: GgufHeaderFacts): ModelImportCheck {
  const title = 'Chat model';
  switch (ggufNonChatKind(header)) {
    case 'adapter':
      return check(
        'kind',
        'fail',
        title,
        "This file is an adapter that changes another model. It can't run on its own.",
      );
    case 'projector':
      return check(
        'kind',
        'fail',
        title,
        'This file is the vision part of a model, not the model itself. Choose the main model file.',
      );
    case 'embedding':
      return check(
        'kind',
        'fail',
        title,
        'This is an embedding model. It turns text into numbers for search and cannot reply to messages.',
      );
    default:
      break;
  }
  if (!header.tokenizerModel) {
    return check(
      'kind',
      'fail',
      title,
      "The file carries no tokenizer, so the engine can't read or write text with it.",
    );
  }
  return check('kind', 'pass', title, 'A language model that writes text.');
}

function architectureCheck(header: GgufHeaderFacts): ModelImportCheck {
  const title = 'Engine support';
  const arch = header.architecture;
  if (!arch) {
    return check('architecture', 'fail', title, "The file doesn't say which design it uses.");
  }
  if (!isSupportedGgufArchitecture(arch)) {
    return check(
      'architecture',
      'fail',
      title,
      `This model uses the "${arch}" design, which the engine in this version of Gezel (llama.cpp ${LLAMA_CPP_GGUF_SUPPORT_TAG}) can't load. A later version of Gezel may.`,
    );
  }
  return check(
    'architecture',
    'pass',
    title,
    `llama.cpp ${LLAMA_CPP_GGUF_SUPPORT_TAG} supports the "${arch}" design.`,
  );
}

function tensorTypeCheck(header: GgufHeaderFacts, backendGap?: string): ModelImportCheck {
  const title = 'Number formats';
  const { removed, unknown } = unreadableGgufTensorTypes(header);
  if (removed.length > 0) {
    return check(
      'tensorTypes',
      'fail',
      title,
      `It stores weights as ${removed.join(', ')}, an old format llama.cpp no longer reads. Choose another file from the same model.`,
    );
  }
  if (unknown.length > 0) {
    return check(
      'tensorTypes',
      'fail',
      title,
      `It stores weights in a format newer than the engine in this version of Gezel (type ${unknown.join(', ')}).`,
    );
  }
  const names = ggufTensorTypeNames(header).slice(0, 4).join(', ');
  if (backendGap) return check('tensorTypes', 'warn', title, backendGap);
  return check(
    'tensorTypes',
    'pass',
    title,
    names ? `The engine reads every format it uses (${names}).` : 'The engine reads its formats.',
  );
}

function chatTemplateCheck(header: GgufHeaderFacts): ModelImportCheck {
  const title = 'Conversation format';
  if (!header.chatTemplate) {
    return check(
      'chatTemplate',
      'fail',
      title,
      "The file doesn't say how to lay out a conversation, so replies would likely come out garbled. Uploads of a model's chat or instruct version (often named '-Instruct' or '-it') include this.",
    );
  }
  return check('chatTemplate', 'pass', title, 'It includes its own conversation format.');
}

function toolCheck(header: GgufHeaderFacts): ModelImportCheck {
  const title = 'Tool use';
  if (!chatTemplateSupportsTools(header.chatTemplate)) {
    return check(
      'toolCalls',
      'warn',
      title,
      "Its conversation format has no place for tools. It can chat, but it can't read files, take notes or work on tasks.",
    );
  }
  return check(
    'toolCalls',
    'pass',
    title,
    'Its conversation format supports tools. Gezel tries a tool call after the download to make sure.',
  );
}

function contextCheck(header: GgufHeaderFacts): ModelImportCheck {
  const title = 'Working memory';
  const ctx = header.contextLength;
  if (!ctx) {
    return check(
      'context',
      'warn',
      title,
      "The file doesn't say how much text it can keep in mind.",
    );
  }
  if (ctx < FITNESS_CONTEXT_FLOOR_TOKENS) {
    return check(
      'context',
      'warn',
      title,
      `It keeps only ${ctx.toLocaleString('en-US')} tokens in mind, too little for longer work with files and tools (Gezel wants ${FITNESS_CONTEXT_FLOOR_TOKENS.toLocaleString('en-US')}).`,
    );
  }
  return check(
    'context',
    'pass',
    title,
    `It keeps up to ${ctx.toLocaleString('en-US')} tokens in mind.`,
  );
}

function memoryCheck(fit: NonNullable<ModelImportEvidence['fit']>): ModelImportCheck {
  const title = 'Fits this computer';
  if (fit.tier === 'too-big') {
    return check(
      'memory',
      'fail',
      title,
      'It needs more memory than this computer has for models. Choose a smaller file.',
    );
  }
  if (fit.tier === 'tight') return check('memory', 'warn', title, fit.detail);
  return check('memory', 'pass', title, fit.detail);
}

function diskCheck(
  disk: NonNullable<ModelImportEvidence['disk']>,
  localFile?: boolean,
): ModelImportCheck {
  const title = 'Disk space';
  const verb = localFile ? 'copy in' : 'download';
  if (!disk.ok) {
    return check(
      'disk',
      'fail',
      title,
      disk.freeBytes !== undefined
        ? `It needs ${formatBytes(disk.neededBytes)} free to ${verb} safely, and the disk has ${formatBytes(disk.freeBytes)}.`
        : `It needs ${formatBytes(disk.neededBytes)} of free space.`,
    );
  }
  return check(
    'disk',
    'pass',
    title,
    disk.freeBytes !== undefined
      ? `${formatBytes(disk.downloadBytes)} to ${verb}, with ${formatBytes(disk.freeBytes)} free.`
      : `${formatBytes(disk.downloadBytes)} to ${verb}.`,
  );
}

/**
 * The ordered check list for a review. A failed check names what is wrong in
 * words a person can act on; nothing here asks them to understand GGUF.
 */
export function buildModelImportChecks(evidence: ModelImportEvidence): ModelImportCheck[] {
  const checks: ModelImportCheck[] = [];
  if (evidence.access) {
    const access = accessCheck(evidence.access);
    checks.push(access);
    // Without access the Hub hides checksums and the file itself, so those
    // checks would only repeat this one.
    if (access.status === 'fail') {
      if (evidence.fit) checks.push(memoryCheck(evidence.fit));
      if (evidence.disk) checks.push(diskCheck(evidence.disk));
      return checks;
    }
  }
  checks.push(integrityCheck(evidence.allFilesHashed, evidence.localFile));
  if (!evidence.header) {
    checks.push(
      check(
        'format',
        'fail',
        'Readable file',
        evidence.headerError
          ? `Gezel couldn't read this file's header: ${evidence.headerError}`
          : "Gezel couldn't read this file's header.",
      ),
    );
  } else {
    const header = evidence.header;
    checks.push(
      check('format', 'pass', 'Readable file', `A GGUF file, version ${header.version}.`),
    );
    const kind = kindCheck(header);
    checks.push(kind);
    if (kind.status !== 'fail') {
      checks.push(architectureCheck(header));
      checks.push(tensorTypeCheck(header, evidence.backendGap));
      checks.push(chatTemplateCheck(header));
      checks.push(toolCheck(header));
      checks.push(contextCheck(header));
    }
  }
  if (evidence.fit) checks.push(memoryCheck(evidence.fit));
  if (evidence.disk) checks.push(diskCheck(evidence.disk, evidence.localFile));
  return checks;
}

export interface MlxImportEvidence {
  access: HubAccess;
  /** Absent when the configs could not be read; see `configError`. */
  config?: MlxConfigFacts;
  configError?: string;
  allFilesHashed: boolean;
  /** MLX runs only on Apple silicon. */
  appleSilicon: boolean;
  fit?: ModelImportEvidence['fit'];
  disk?: ModelImportEvidence['disk'];
}

function platformCheck(appleSilicon: boolean): ModelImportCheck {
  return appleSilicon
    ? check('platform', 'pass', 'This computer', 'MLX models run on Apple silicon, like this Mac.')
    : check(
        'platform',
        'fail',
        'This computer',
        'MLX models run only on Mac computers with Apple silicon. Look for a GGUF version of this model instead.',
      );
}

/** The ordered checks for an MLX repository. */
export function buildMlxImportChecks(evidence: MlxImportEvidence): ModelImportCheck[] {
  const access = accessCheck(evidence.access);
  const checks: ModelImportCheck[] = [access, platformCheck(evidence.appleSilicon)];
  if (access.status === 'fail') {
    if (evidence.fit) checks.push(memoryCheck(evidence.fit));
    if (evidence.disk) checks.push(diskCheck(evidence.disk));
    return checks;
  }
  checks.push(integrityCheck(evidence.allFilesHashed));
  const config = evidence.config;
  if (!config) {
    checks.push(
      check(
        'format',
        'fail',
        'Readable model',
        evidence.configError
          ? `Gezel couldn't read this model's configuration: ${evidence.configError}`
          : "Gezel couldn't read this model's configuration.",
      ),
    );
  } else {
    checks.push(check('format', 'pass', 'Readable model', 'An MLX model with its configuration.'));
    checks.push(
      config.customCode
        ? check(
            'customCode',
            'fail',
            'No code inside',
            'This model asks to run its own program code when it loads. Gezel never runs code from a downloaded model.',
          )
        : check(
            'customCode',
            'pass',
            'No code inside',
            'It is data only; nothing in it runs as a program.',
          ),
    );
    const type = config.modelType;
    checks.push(
      !type
        ? check(
            'architecture',
            'fail',
            'Engine support',
            "The configuration doesn't say which design it uses.",
          )
        : isSupportedMlxModelType(type)
          ? check(
              'architecture',
              'pass',
              'Engine support',
              `mlx-vlm ${MLX_VLM_SUPPORT_VERSION} supports the "${type}" design.`,
            )
          : check(
              'architecture',
              'fail',
              'Engine support',
              `This model uses the "${type}" design, which the MLX engine in this version of Gezel (mlx-vlm ${MLX_VLM_SUPPORT_VERSION}) can't load. A later version of Gezel may.`,
            ),
    );
    const template = {
      version: 0,
      ...(config.chatTemplate ? { chatTemplate: config.chatTemplate } : {}),
    };
    checks.push(chatTemplateCheck(template));
    checks.push(toolCheck(template));
    checks.push(
      contextCheck({
        version: 0,
        ...(config.contextLength ? { contextLength: config.contextLength } : {}),
      }),
    );
  }
  if (evidence.fit) checks.push(memoryCheck(evidence.fit));
  if (evidence.disk) checks.push(diskCheck(evidence.disk));
  return checks;
}

/** A review with any failed check offers no download. */
export function modelImportBlocked(checks: readonly ModelImportCheck[]): boolean {
  return checks.some((item) => item.status === 'fail');
}
