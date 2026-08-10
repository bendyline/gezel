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
    ).toBe(' · ~21.2 GB in memory');
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
});
