import { estimateLlamaCppResidentBytes } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  ds4MemoryHeadline,
  ds4SizeTitle,
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

describe('ds4 memory copy', () => {
  const GiB = 1024 ** 3;
  // Real DeepSeek V4 geometry: 80 GB working set measured at 128K, 8 KiB/token.
  const KV_PER_TOKEN = 8192;
  const CONTEXT_FREE = 80 * GiB - KV_PER_TOKEN * 131_072;
  const projected = (ctxTokens: number) => ({
    approxSizeBytes: 153 * GiB,
    residentBytes: CONTEXT_FREE + KV_PER_TOKEN * ctxTokens,
    contextFreeBytes: CONTEXT_FREE,
    effectiveContextWindow: ctxTokens,
  });

  it('drops the hedge once the figure is re-based on a real window', () => {
    expect(ds4MemoryHeadline(projected(131_072))).toBe('80.0 GB in memory');
  });

  it('keeps the hedge on a flat authored footprint', () => {
    // No slope to re-base against: the number does not move with the window,
    // and saying so is the whole point of the tilde.
    expect(ds4MemoryHeadline({ approxSizeBytes: 197 * GiB, residentBytes: 57 * GiB })).toBe(
      '~57.0 GB in memory',
    );
  });

  it('resolves a smaller window to a smaller working set', () => {
    // The half-gigabyte that whole-GB rounding used to erase.
    expect(ds4MemoryHeadline(projected(65_536))).toBe('79.5 GB in memory');
  });

  it('says nothing when there is no resident figure at all', () => {
    expect(ds4MemoryHeadline({ approxSizeBytes: 153 * GiB })).toBeNull();
  });

  it('breaks the tooltip into the part that moves and the part that does not', () => {
    const title = ds4SizeTitle(projected(131_072));
    expect(title).toContain('153.0 GB on disk');
    expect(title).toContain('routed experts stream from it');
    expect(title).toContain('79.0 GB of routed-expert cache and resident model state');
    expect(title).toContain('1.0 GB of context (KV)');
    expect(title).toContain('Only the second figure moves');
  });

  it('does not invent a context breakdown for a flat footprint', () => {
    const title = ds4SizeTitle({ approxSizeBytes: 197 * GiB, residentBytes: 57 * GiB });
    expect(title).toContain('no per-token slope');
    expect(title).not.toContain('context (KV)');
  });

  it('never reports a negative context term from a mis-authored slope', () => {
    // contextFree above the total would otherwise print a negative KV figure.
    const title = ds4SizeTitle({
      approxSizeBytes: 153 * GiB,
      residentBytes: 40 * GiB,
      contextFreeBytes: 50 * GiB,
      effectiveContextWindow: 131_072,
    });
    expect(title).toContain('no per-token slope');
    expect(
      ds4MemoryHeadline({
        approxSizeBytes: 153 * GiB,
        residentBytes: 40 * GiB,
        contextFreeBytes: 50 * GiB,
      }),
    ).toBe('~40.0 GB in memory');
  });
});
