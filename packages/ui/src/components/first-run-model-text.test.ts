import { describe, expect, it } from 'vitest';
import { formatDownloadProgress, readSizeFromCatalog } from './first-run-model-text.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('formatDownloadProgress', () => {
  it('says how much has arrived out of how much', () => {
    expect(formatDownloadProgress(1.2 * GB, 15.3 * GB)).toBe('1.2 GB of 15.3 GB');
    expect(formatDownloadProgress(4 * GB, 16 * GB)).toBe('4.0 GB of 16.0 GB');
  });

  it('counts in megabytes below a gigabyte', () => {
    expect(formatDownloadProgress(680 * MB, 3.9 * GB)).toBe('680 MB of 3.9 GB');
    expect(formatDownloadProgress(0, 3.9 * GB)).toBe('0 MB of 3.9 GB');
    expect(formatDownloadProgress(120 * MB, 700 * MB)).toBe('120 MB of 700 MB');
  });

  // A resumed download can report bytes past the catalog's size for a moment.
  it('never reports more than the whole, or less than nothing', () => {
    expect(formatDownloadProgress(17 * GB, 16 * GB)).toBe('16.0 GB of 16.0 GB');
    expect(formatDownloadProgress(-5, 16 * GB)).toBe('0 MB of 16.0 GB');
  });
});

describe('readSizeFromCatalog', () => {
  const manifest = {
    kind: 'chat-model',
    approxSizeBytes: 15 * GB,
    llamaCpp: { approxSizeBytes: 15 * GB, mmproj: { sizeBytes: 1 * GB } },
    mlx: { approxSizeBytes: 14 * GB },
  };

  // The key said 15.3 GB and the progress line then counted to 16.2 GB.
  it('counts the vision file a llama.cpp model downloads with its weights', () => {
    expect(readSizeFromCatalog({ manifest }, 'llama-cpp')).toBe(16 * GB);
  });

  it('counts only the weights where there is no vision file', () => {
    expect(readSizeFromCatalog({ manifest }, 'mlx')).toBe(14 * GB);
    expect(
      readSizeFromCatalog(
        { manifest: { kind: 'chat-model', approxSizeBytes: 4 * GB } },
        'llama-cpp',
      ),
    ).toBe(4 * GB);
  });

  it('has no size for anything that is not a chat model', () => {
    expect(readSizeFromCatalog(null, 'llama-cpp')).toBeNull();
    expect(readSizeFromCatalog({ manifest: { kind: 'toolset' } }, 'llama-cpp')).toBeNull();
  });
});
