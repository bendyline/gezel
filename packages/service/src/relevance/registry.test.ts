import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELEVANCE_MODEL_ID, RELEVANCE_MODELS, findRelevanceModel } from './registry.js';

describe('relevance model registry', () => {
  it('pins every model consistently', () => {
    const ids = RELEVANCE_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of RELEVANCE_MODELS) {
      const paths = model.files.map((file) => file.path);
      expect(paths, model.id).toContain(model.graph);
      expect(paths, model.id).toContain('config.json');
      expect(paths, model.id).toContain('tokenizer.json');
      expect(model.approxBytes).toBe(model.files.reduce((sum, file) => sum + file.bytes, 0));
      expect(model.queryMaxTokens).toBeLessThan(model.maxTokens);
    }
  });

  // An uncalibrated model can only reorder; a calibrated one must say where
  // its thresholds came from.
  it('records the bench run behind every calibrated threshold', () => {
    for (const model of RELEVANCE_MODELS) {
      expect(model.thresholds === null, model.id).toBe(model.calibration === null);
      if (model.calibration) {
        // The record must be committed: run directories are not.
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
        expect(existsSync(resolve(repoRoot, model.calibration.evalRun)), model.id).toBe(true);
      }
    }
  });

  it('offers a non-experimental default', () => {
    expect(findRelevanceModel(DEFAULT_RELEVANCE_MODEL_ID)?.experimental).not.toBe(true);
    expect(findRelevanceModel('nope@1')).toBeNull();
  });
});
