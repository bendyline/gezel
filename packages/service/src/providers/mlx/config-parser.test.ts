import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMlxSummary } from './config-parser.js';

describe('readMlxSummary', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mlx-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts context window from max_position_embeddings', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ max_position_embeddings: 32768, architectures: ['GemmaForCausalLM'] }),
      'utf8',
    );
    const summary = await readMlxSummary(dir);
    expect(summary.contextWindow).toBe(32768);
    expect(summary.architecture).toBe('GemmaForCausalLM');
    expect(summary.chatTemplatePresent).toBe(false);
  });

  it('falls back to n_positions when max_position_embeddings absent', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ n_positions: 8192, model_type: 'llama' }),
      'utf8',
    );
    const summary = await readMlxSummary(dir);
    expect(summary.contextWindow).toBe(8192);
    expect(summary.architecture).toBe('llama');
  });

  it('detects chat_template in tokenizer_config.json', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ max_position_embeddings: 4096 }),
      'utf8',
    );
    await writeFile(
      join(dir, 'tokenizer_config.json'),
      JSON.stringify({
        chat_template: '{% for message in messages %}{{ message.role }}{% endfor %}',
      }),
      'utf8',
    );
    const summary = await readMlxSummary(dir);
    expect(summary.chatTemplatePresent).toBe(true);
  });

  it('returns null context window when no known key is present', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hidden_size: 2048 }), 'utf8');
    const summary = await readMlxSummary(dir);
    expect(summary.contextWindow).toBeNull();
  });

  it('tolerates completely missing files', async () => {
    const summary = await readMlxSummary(dir);
    expect(summary.contextWindow).toBeNull();
    expect(summary.architecture).toBeNull();
    expect(summary.chatTemplatePresent).toBe(false);
  });

  it('tolerates malformed JSON', async () => {
    await writeFile(join(dir, 'config.json'), '{not valid json', 'utf8');
    const summary = await readMlxSummary(dir);
    expect(summary.contextWindow).toBeNull();
  });

  it('rejects non-positive or non-finite context values', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ max_position_embeddings: -1, n_positions: 0, n_ctx: 4096 }),
      'utf8',
    );
    const summary = await readMlxSummary(dir);
    expect(summary.contextWindow).toBe(4096);
  });
});
