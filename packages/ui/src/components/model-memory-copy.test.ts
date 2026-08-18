import { estimateLlamaCppResidentBytes } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatMemoryBytes,
  modelMemoryHeadline,
  modelSizeTitle,
} from './model-memory-copy.js';

describe('model memory copy', () => {
  it('uses decimal GB for disk and hardware-style binary GB for memory', () => {
    const bytes = 21.2 * 1024 ** 3;

    expect(formatBytes(bytes)).toBe('21.2 GB');
    expect(formatMemoryBytes(bytes)).toBe('21.2 GB');
    expect(
      modelMemoryHeadline({ approxSizeBytes: 17_106_773_120, predictedResidentBytes: bytes }),
    ).toBe('~21.2 GB in memory');
  });

  it('keeps disk and memory scales distinct in the explanatory tooltip', () => {
    expect(
      modelSizeTitle({
        approxSizeBytes: 17_106_773_120,
        predictedResidentBytes: 21.2 * 1024 ** 3,
        reservedResidentBytes: 30 * 1024 ** 3,
        plannedSlots: 2,
      }),
    ).toBe(
      '15.9 GB on disk. Expect about 21.2 GB of memory to serve one chat: weights plus the KV cache at the granted context window. Serving 2 chats at once reserves about 30.0 GB.',
    );
  });

  it('breaks the single-chat figure into weights and KV when the plan reports both', () => {
    expect(
      modelSizeTitle({
        approxSizeBytes: 17_106_773_120,
        predictedResidentBytes: 28 * 1024 ** 3,
        weightsResidentBytes: 20 * 1024 ** 3,
        effectiveContextWindow: 65_536,
      }),
    ).toBe(
      '15.9 GB on disk. Expect about 28.0 GB of memory to serve one chat: 15.9 GB of model weights and 4.1 GB of engine overhead, plus 8.0 GB of KV cache at the granted 64K context window.',
    );
  });

  it('ties the weights term back to the on-disk figure so the gap reads as overhead', () => {
    // Fed the same estimate the daemon sends, so the copy stays honest if
    // the resident-bytes formula is retuned.
    const title = modelSizeTitle({
      approxSizeBytes: 17_106_773_120,
      predictedResidentBytes: 28 * 1024 ** 3,
      weightsResidentBytes: estimateLlamaCppResidentBytes(17_106_773_120),
      effectiveContextWindow: 262_144,
    });

    expect(title).toContain('15.9 GB on disk.');
    expect(title).toContain('15.9 GB of model weights and 1.8 GB of engine overhead');
  });

  it('keeps the weights term whole when the overhead is not a visible slice', () => {
    const base = {
      approxSizeBytes: 17_106_773_120,
      predictedResidentBytes: 28 * 1024 ** 3,
      effectiveContextWindow: 65_536,
    };

    expect(
      modelSizeTitle({ ...base, weightsResidentBytes: 17_106_773_120 + 8 * 1024 ** 2 }),
    ).toContain('15.9 GB for the model weights,');
    // A streaming engine's resident set is smaller than the file it reads
    // from — that is not an overhead, and quoting a negative one is nonsense.
    expect(modelSizeTitle({ ...base, weightsResidentBytes: 10 * 1024 ** 3 })).toContain(
      '10.0 GB for the model weights,',
    );
  });

  it('quotes the per-chat share in the multi-slot reservation sentence', () => {
    expect(
      modelSizeTitle({
        approxSizeBytes: 17_106_773_120,
        predictedResidentBytes: 28 * 1024 ** 3,
        reservedResidentBytes: 44 * 1024 ** 3,
        plannedSlots: 3,
        weightsResidentBytes: 20 * 1024 ** 3,
        effectiveContextWindow: 65_536,
      }),
    ).toBe(
      '15.9 GB on disk. Expect about 28.0 GB of memory to serve one chat: 15.9 GB of model weights and 4.1 GB of engine overhead, plus 8.0 GB of KV cache at the granted 64K context window. Serving 3 chats at once reserves about 44.0 GB: one copy of the weights plus 8.0 GB for each chat.',
    );
  });

  it('breaks out fixed context state only when it is a visible slice', () => {
    const base = {
      approxSizeBytes: 17_106_773_120,
      predictedResidentBytes: 28 * 1024 ** 3,
      weightsResidentBytes: 20 * 1024 ** 3,
      effectiveContextWindow: 65_536,
    };

    expect(modelSizeTitle({ ...base, kvFixedBytesPerSlot: 2 * 1024 ** 3 })).toContain(
      'plus 6.0 GB of KV cache and 2.0 GB of fixed context state at the granted 64K context window',
    );
    expect(modelSizeTitle({ ...base, kvFixedBytesPerSlot: 8 * 1024 ** 2 })).toContain(
      'plus 8.0 GB of KV cache at the granted 64K context window',
    );
  });

  it('falls back to the generic sentence when the weights share is unknown or nonsensical', () => {
    expect(
      modelSizeTitle({
        approxSizeBytes: 17_106_773_120,
        predictedResidentBytes: 28 * 1024 ** 3,
        weightsResidentBytes: 30 * 1024 ** 3,
      }),
    ).toBe(
      '15.9 GB on disk. Expect about 28.0 GB of memory to serve one chat: weights plus the KV cache at the granted context window.',
    );
  });
});
