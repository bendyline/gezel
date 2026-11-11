import { describe, expect, it } from 'vitest';
import { buildMlxImportChecks, modelImportBlocked } from './checks.js';
import {
  isSupportedMlxModelType,
  mlxConfigFacts,
  mlxModelRoots,
  mlxQuantizationLabel,
  selectMlxFiles,
} from './mlx.js';

const sha = (n: number) => n.toString(16).padStart(64, '0');

const files = [
  { path: 'README.md', sizeBytes: 10 },
  { path: 'config.json', sizeBytes: 900 },
  { path: 'model-00001-of-00002.safetensors', sizeBytes: 4e9, sha256: sha(1) },
  { path: 'model-00002-of-00002.safetensors', sizeBytes: 1e9, sha256: sha(2) },
  { path: 'model.safetensors.index.json', sizeBytes: 50_000 },
  { path: 'tokenizer.json', sizeBytes: 11e6, sha256: sha(3) },
  { path: 'tokenizer_config.json', sizeBytes: 5000 },
  { path: 'modeling_qwen.py', sizeBytes: 3000 },
  { path: 'images/chart.png', sizeBytes: 3000 },
  { path: '8bit/config.json', sizeBytes: 900 },
  { path: '8bit/model.safetensors', sizeBytes: 9e9, sha256: sha(4) },
];

describe('MLX repo layout', () => {
  it('finds each build and selects only its data files', () => {
    expect(mlxModelRoots(files)).toEqual(['', '8bit']);
    expect(selectMlxFiles(files, '').map((file) => file.path)).toEqual([
      'config.json',
      'model-00001-of-00002.safetensors',
      'model-00002-of-00002.safetensors',
      'model.safetensors.index.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ]);
    expect(selectMlxFiles(files, '8bit').map((file) => file.path)).toEqual([
      '8bit/config.json',
      '8bit/model.safetensors',
    ]);
  });
});

describe('mlxConfigFacts', () => {
  it('reads the design, quantization, context and template', () => {
    const facts = mlxConfigFacts({
      config: {
        model_type: 'mistral',
        quantization: { bits: 4, group_size: 64 },
        max_position_embeddings: 32_768,
      },
      tokenizerConfig: { chat_template: '{{ messages }}' },
    });
    // mlx-vlm reads `mistral` checkpoints with its llama model.
    expect(facts).toMatchObject({
      modelType: 'llama',
      quantizationBits: 4,
      contextLength: 32_768,
      customCode: false,
      vision: false,
      chatTemplate: '{{ messages }}',
    });
    expect(mlxQuantizationLabel(facts)).toBe('4bit');
    expect(isSupportedMlxModelType('llama')).toBe(true);
    expect(isSupportedMlxModelType('not-a-design')).toBe(false);
  });

  it('notices a request to run code anywhere in the configs', () => {
    expect(mlxConfigFacts({ config: { model_type: 'qwen3', model_file: 'm.py' } }).customCode).toBe(
      true,
    );
    expect(
      mlxConfigFacts({ config: { model_type: 'qwen3' }, tokenizerConfig: { auto_map: {} } })
        .customCode,
    ).toBe(true);
    expect(
      mlxConfigFacts({ config: { model_type: 'qwen3' }, processorConfigs: [{ auto_map: {} }] })
        .customCode,
    ).toBe(true);
  });

  it('prefers a template file over the tokenizer config', () => {
    expect(
      mlxConfigFacts({
        config: { model_type: 'qwen3' },
        chatTemplateJinja: 'from jinja',
        tokenizerConfig: { chat_template: 'from tokenizer' },
      }).chatTemplate,
    ).toBe('from jinja');
  });
});

describe('buildMlxImportChecks', () => {
  const base = {
    access: { gated: false as const, private: false, disabled: false, hasToken: false },
    allFilesHashed: true,
    appleSilicon: true,
    config: mlxConfigFacts({
      config: { model_type: 'qwen3', max_position_embeddings: 40_960 },
      tokenizerConfig: { chat_template: '{% if tools %}{% endif %}' },
    }),
  };

  it('passes a data-only build of a supported design on Apple silicon', () => {
    const checks = buildMlxImportChecks(base);
    expect(checks.every((item) => item.status === 'pass')).toBe(true);
  });

  it('blocks custom code and other computers', () => {
    expect(
      modelImportBlocked(
        buildMlxImportChecks({ ...base, config: { ...base.config, customCode: true } }),
      ),
    ).toBe(true);
    const pc = buildMlxImportChecks({ ...base, appleSilicon: false });
    expect(pc.find((item) => item.id === 'platform')?.status).toBe('fail');
  });
});
