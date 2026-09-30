/**
 * Coverage for the marker behaviors (`turn.preamble-folding`,
 * `parse.gemma-special-token`) and the parameterized
 * `turn.ramble-detection`. The markers are simple — assert id +
 * description shape and that no surprise hooks were attached. The
 * parameterized one validates the Zod schema's bounds and defaulting.
 */

import { describe, expect, it } from 'vitest';
import { ParseGemmaSpecialToken } from './parse-gemma-special-token.js';
import { TurnPreambleFolding } from './turn-preamble-folding.js';
import { TurnRambleDetection } from './turn-ramble-detection.js';

describe('TurnPreambleFolding (marker)', () => {
  it('exposes a stable id', () => {
    expect(TurnPreambleFolding.id).toBe('turn.preamble-folding');
  });

  it('has no runtime hooks — wiring lives in the providers', () => {
    expect(TurnPreambleFolding.promptAppend).toBeUndefined();
    expect(TurnPreambleFolding.userPromptPrelude).toBeUndefined();
    expect(TurnPreambleFolding.postTurnDetector).toBeUndefined();
    expect(TurnPreambleFolding.captureReasoning).toBeUndefined();
    expect(TurnPreambleFolding.mcpWrapper).toBeUndefined();
    expect(TurnPreambleFolding.numPredict).toBeUndefined();
    expect(TurnPreambleFolding.continuationBudget).toBeUndefined();
  });
});

describe('ParseGemmaSpecialToken (marker)', () => {
  it('exposes a stable id', () => {
    expect(ParseGemmaSpecialToken.id).toBe('parse.gemma-special-token');
  });

  it('has no runtime hooks — the salvage path consults the marker', () => {
    expect(ParseGemmaSpecialToken.promptAppend).toBeUndefined();
    expect(ParseGemmaSpecialToken.captureReasoning).toBeUndefined();
    expect(ParseGemmaSpecialToken.mcpWrapper).toBeUndefined();
  });
});

describe('TurnRambleDetection', () => {
  it('parses a valid config', () => {
    const out = TurnRambleDetection.configSchema!.safeParse({
      coldThreshold: 4000,
      postActionThreshold: 1000,
    });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.coldThreshold).toBe(4000);
      expect(out.data.postActionThreshold).toBe(1000);
    }
  });

  it('rejects an empty config — both fields are required', () => {
    // The whole-config defaultConfig handles the "manifest opted in
    // without supplying any config" case; we don't accept partial
    // configs that elide one threshold.
    const out = TurnRambleDetection.configSchema!.safeParse({});
    expect(out.success).toBe(false);
  });

  it('rejects coldThreshold outside [500, 50000]', () => {
    expect(TurnRambleDetection.configSchema!.safeParse({ coldThreshold: 100 }).success).toBe(false);
    expect(TurnRambleDetection.configSchema!.safeParse({ coldThreshold: 100000 }).success).toBe(
      false,
    );
  });

  it('rejects postActionThreshold outside [200, 20000]', () => {
    expect(TurnRambleDetection.configSchema!.safeParse({ postActionThreshold: 50 }).success).toBe(
      false,
    );
    expect(
      TurnRambleDetection.configSchema!.safeParse({ postActionThreshold: 50000 }).success,
    ).toBe(false);
  });

  it('rejects non-integer thresholds', () => {
    expect(TurnRambleDetection.configSchema!.safeParse({ coldThreshold: 6000.5 }).success).toBe(
      false,
    );
  });

  it('exposes a defaultConfig matching the universal RambleDetector defaults', () => {
    expect(TurnRambleDetection.defaultConfig).toEqual({
      coldThreshold: 6000,
      postActionThreshold: 1500,
    });
  });
});
