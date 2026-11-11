import { describe, expect, it } from 'vitest';
import {
  ggufChoiceForFile,
  ggufQuantFromFilename,
  layoutGgufRepo,
  pickGgufChoice,
  pickGgufProjector,
} from './gguf-files.js';

const GB = 1024 ** 3;
const sha = (n: number) => n.toString(16).padStart(64, '0');

const files = [
  { path: 'README.md', sizeBytes: 100 },
  { path: 'Qwen3-8B-Q4_K_M.gguf', sizeBytes: 5 * GB, sha256: sha(1) },
  { path: 'Qwen3-8B-Q8_0.gguf', sizeBytes: 9 * GB, sha256: sha(2) },
  { path: 'Qwen3-8B-UD-Q2_K_XL.gguf', sizeBytes: 3 * GB, sha256: sha(3) },
  { path: 'BF16/Qwen3-8B-BF16-00001-of-00002.gguf', sizeBytes: 8 * GB, sha256: sha(4) },
  { path: 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf', sizeBytes: 8 * GB, sha256: sha(5) },
  { path: 'F32/Qwen3-8B-F32-00001-of-00003.gguf', sizeBytes: 10 * GB, sha256: sha(6) },
  { path: 'mmproj-F16.gguf', sizeBytes: GB, sha256: sha(7) },
  { path: 'mmproj-BF16.gguf', sizeBytes: GB, sha256: sha(8) },
  { path: 'imatrix_unsloth.gguf', sizeBytes: 10_000, sha256: sha(9) },
  { path: 'eagle3-Qwen3-8B-Q8_0.gguf', sizeBytes: GB, sha256: sha(10) },
];

describe('ggufQuantFromFilename', () => {
  it('reads the quant tags uploaders use', () => {
    expect(ggufQuantFromFilename('Qwen3-8B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(ggufQuantFromFilename('gemma-3-4b-it-qat-q4_0.gguf')).toBe('Q4_0');
    expect(ggufQuantFromFilename('Model-UD-Q4_K_XL.gguf')).toBe('UD-Q4_K_XL');
    expect(ggufQuantFromFilename('gpt-oss-20b-mxfp4.gguf')).toBe('MXFP4');
    expect(ggufQuantFromFilename('BF16/Qwen3-8B-BF16-00001-of-00002.gguf')).toBe('BF16');
    expect(ggufQuantFromFilename('Qwen3-8B.gguf')).toBeUndefined();
  });
});

describe('layoutGgufRepo', () => {
  const layout = layoutGgufRepo(files);

  it('groups splits, sets projectors aside, and drops importance matrices', () => {
    expect(layout.choices.map((choice) => choice.key)).toEqual([
      'Qwen3-8B-UD-Q2_K_XL.gguf',
      'Qwen3-8B-Q4_K_M.gguf',
      'Qwen3-8B-Q8_0.gguf',
      'BF16/Qwen3-8B-BF16-00001-of-00002.gguf',
    ]);
    const bf16 = layout.choices.find((choice) => choice.quant === 'BF16');
    expect(bf16?.files).toHaveLength(2);
    expect(bf16?.sizeBytes).toBe(16 * GB);
    expect(layout.projectors.map((file) => file.path)).toEqual([
      'mmproj-F16.gguf',
      'mmproj-BF16.gguf',
    ]);
  });

  it('never offers a split model with a shard missing', () => {
    expect(layout.incompleteSplits).toEqual(['F32/Qwen3-8B-F32']);
  });

  it('finds the choice holding any shard', () => {
    expect(ggufChoiceForFile(layout, 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf')?.key).toBe(
      'BF16/Qwen3-8B-BF16-00001-of-00002.gguf',
    );
  });
});

describe('pickGgufChoice', () => {
  const layout = layoutGgufRepo(files);

  it('prefers a 4-bit K-quant', () => {
    expect(pickGgufChoice(layout)?.key).toBe('Qwen3-8B-Q4_K_M.gguf');
  });

  it('honors an explicit file or quant', () => {
    expect(pickGgufChoice(layout, { file: 'Qwen3-8B-Q8_0.gguf' })?.key).toBe('Qwen3-8B-Q8_0.gguf');
    expect(pickGgufChoice(layout, { quant: 'q8_0' })?.key).toBe('Qwen3-8B-Q8_0.gguf');
  });

  it('takes the best choice that fits, else the smallest', () => {
    expect(pickGgufChoice(layout, { fits: (choice) => choice.sizeBytes <= 4 * GB })?.key).toBe(
      'Qwen3-8B-UD-Q2_K_XL.gguf',
    );
    expect(pickGgufChoice(layout, { fits: () => false })?.key).toBe('Qwen3-8B-UD-Q2_K_XL.gguf');
  });
});

describe('pickGgufProjector', () => {
  it('prefers the F16 projector', () => {
    expect(pickGgufProjector(layoutGgufRepo(files).projectors)?.path).toBe('mmproj-F16.gguf');
    expect(pickGgufProjector([])).toBeUndefined();
  });
});
