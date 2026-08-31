import { describe, expect, it } from 'vitest';
import {
  lintAllChatModelManifests,
  lintChatModelManifest,
  tierForParams,
} from './chat-model-manifest-lint.js';

/**
 * Ratchet test: the lint runs over the real catalog data. Known gaps are
 * enumerated below as a burn-down list — fixing a manifest requires
 * deleting its entry here (the test fails on stale entries too), and any
 * NEW gap fails immediately. This is what turns "the gemma4-26b-q4 QAT
 * swap silently deleted the tuning block and nobody noticed for days"
 * into a CI failure at commit time.
 */
const KNOWN_GAPS: ReadonlyArray<`${string} ${string}`> = [];

describe('chat-model manifest lint (ratchet over real catalog data)', () => {
  const report = lintAllChatModelManifests();

  it('lints every bundled chat model', () => {
    expect(report.modelCount).toBeGreaterThanOrEqual(20);
  });

  it('no NEW manifest gaps beyond the known burn-down list', () => {
    const found = report.errors.map((f) => `${f.modelId} ${f.rule}`);
    const newGaps = found.filter((f) => !KNOWN_GAPS.includes(f as `${string} ${string}`));
    expect(
      newGaps,
      'New manifest gap(s) detected. Either fix the manifest (preferred) or, if the gap is ' +
        'genuinely deferred, add it to KNOWN_GAPS with a burn-down plan.',
    ).toEqual([]);
  });

  it('burn-down list carries no stale entries (fixed manifests must be removed from it)', () => {
    const found = new Set(report.errors.map((f) => `${f.modelId} ${f.rule}`));
    const stale = KNOWN_GAPS.filter((g) => !found.has(g));
    expect(
      stale,
      'These KNOWN_GAPS entries no longer fire — delete them so the ratchet only moves forward.',
    ).toEqual([]);
  });
});

describe('lintChatModelManifest rules', () => {
  const complete = {
    id: 'test-model',
    parameterSize: '8B',
    style: { reasoningFormat: 'think' },
    tuning: {
      sampling: { temperature: 0.7 },
      reasoning: { thinkingBudget: 2048 },
      profiles: { 'thinking-general': {} },
    },
    // 8B => small tier, so a well-formed manifest re-declares the small-tier
    // defaults it would otherwise silently opt out of, plus the small-model
    // rescue behaviors.
    behaviors: [
      'mcp.relax-required-fields',
      'mcp.default-missing-fields',
      'prompt.tool-cookbook-condensed',
      'mcp.compact-tool-schemas',
      'fabrication.detect-past-tense-no-tools',
      'prompt.retrieval-first',
    ],
    llamaCpp: { residentBytes: 5_000_000_000 },
  };

  it('a complete manifest produces no findings', () => {
    const r = lintChatModelManifest(complete);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  describe('mlx chat template override (stale-template families)', () => {
    const gemma = {
      ...complete,
      id: 'gemma4-12b-q4',
      llamaCpp: {
        ...complete.llamaCpp,
        huggingfaceRepo: 'unsloth/x-qat-GGUF',
        quantization: '4bit',
      },
      mlx: {
        residentBytes: 9_000_000_000,
        huggingfaceRepo: 'vendor/x-qat-4bit',
        quantization: '4bit',
        chatTemplateOverride: '{%- set preserve_thinking = false -%}{{ messages }}',
      },
    };

    it('accepts a gemma4 manifest carrying an override', () => {
      const rules = lintChatModelManifest(gemma).errors.map((e) => e.rule);
      expect(rules).not.toContain('mlx-missing-chat-template-override');
    });

    it('fires when a gemma4 manifest has an MLX source but no override', () => {
      const { chatTemplateOverride: _dropped, ...mlx } = gemma.mlx;
      const rules = lintChatModelManifest({ ...gemma, mlx }).errors.map((e) => e.rule);
      expect(rules).toContain('mlx-missing-chat-template-override');
    });

    it('fires when the override is not a Jinja template (a fetched error page)', () => {
      const mlx = { ...gemma.mlx, chatTemplateOverride: '<html>404 Not Found</html>' };
      const rules = lintChatModelManifest({ ...gemma, mlx }).errors.map((e) => e.rule);
      expect(rules).toContain('mlx-chat-template-override-not-jinja');
    });

    it('does not require an override from families outside the list', () => {
      const { chatTemplateOverride: _dropped, ...mlx } = gemma.mlx;
      const rules = lintChatModelManifest({ ...gemma, id: 'qwen3.6-27b-q4', mlx }).errors.map(
        (e) => e.rule,
      );
      expect(rules).not.toContain('mlx-missing-chat-template-override');
    });

    it('does not require an override from a gemma4 entry with no MLX source at all', () => {
      const rules = lintChatModelManifest({ ...gemma, mlx: undefined }).errors.map((e) => e.rule);
      expect(rules).not.toContain('mlx-missing-chat-template-override');
    });
  });

  it.each(['OpenMDW-1.0', 'OpenMDW-1.1'])(
    '%s is permissive and must use the open license class',
    (license) => {
      expect(lintChatModelManifest({ ...complete, license, licenseClass: 'open' }).errors).toEqual(
        [],
      );
      expect(
        lintChatModelManifest({
          ...complete,
          license,
          licenseClass: 'custom-restricted',
        }).errors.map((f) => f.rule),
      ).toContain('openmdw-not-open');
      expect(lintChatModelManifest({ ...complete, license }).errors.map((f) => f.rule)).toContain(
        'openmdw-not-open',
      );
    },
  );

  it('missing tuning block is an error', () => {
    const { tuning: _drop, ...rest } = complete;
    const r = lintChatModelManifest(rest);
    expect(r.errors.map((f) => f.rule)).toContain('missing-tuning');
  });

  it('thinking model without a reasoning bound is an error; effort, native strength, or disabled thinking count as bounds', () => {
    const unbounded = { ...complete, tuning: { ...complete.tuning, reasoning: {} } };
    expect(lintChatModelManifest(unbounded).errors.map((f) => f.rule)).toContain(
      'unbounded-reasoning',
    );
    const effort = { ...complete, tuning: { ...complete.tuning, reasoning: { effort: 'high' } } };
    expect(lintChatModelManifest(effort).errors).toEqual([]);
    const nativeStrength = {
      ...complete,
      tuning: {
        ...complete.tuning,
        reasoning: { enableThinking: true, templateKwargs: { reasoning_strength: 'high' } },
      },
    };
    expect(lintChatModelManifest(nativeStrength).errors).toEqual([]);
    const disabled = {
      ...complete,
      tuning: { ...complete.tuning, reasoning: { enableThinking: false } },
    };
    expect(lintChatModelManifest(disabled).errors).toEqual([]);
    const nonThinking = {
      ...complete,
      style: { reasoningFormat: 'none' },
      tuning: { ...complete.tuning, reasoning: {} },
    };
    expect(lintChatModelManifest(nonThinking).errors).toEqual([]);
  });

  it('only ds4 must pin residentBytes — llama.cpp and MLX derive it', () => {
    const { llamaCpp: _drop, ...rest } = complete;
    // No pin anywhere is fine: both estimators are measured, and a pin that
    // restates the formula is what produced the KV-double-counting 1.2-1.3x.
    expect(lintChatModelManifest(rest).errors).toEqual([]);
    expect(lintChatModelManifest({ ...rest, mlx: {} }).errors).toEqual([]);
    // ds4 cannot be derived from the file size — it streams experts from SSD.
    expect(lintChatModelManifest({ ...rest, ds4: {} }).errors.map((f) => f.rule)).toContain(
      'missing-resident-bytes',
    );
    expect(lintChatModelManifest({ ...rest, ds4: { residentBytes: 1 } }).errors).toEqual([]);
  });

  it('small model without rescue behaviors warns; large model does not', () => {
    const small = { ...complete, behaviors: ['turn.preamble-folding'] };
    expect(lintChatModelManifest(small).warnings.map((f) => f.rule)).toContain(
      'missing-small-model-rescue-behaviors',
    );
    const large = { ...small, parameterSize: '70B' };
    expect(lintChatModelManifest(large).warnings.map((f) => f.rule)).not.toContain(
      'missing-small-model-rescue-behaviors',
    );
  });
  // Cross-engine quant parity. The 2026-07-31 sweep traced the entire gemma
  // MLX deficit to these three shapes, not to the engine.
  describe('cross-engine quant parity', () => {
    const twoEngine = (llamaCpp: object, mlx: object) => ({ ...complete, llamaCpp, mlx });

    it('flags a bit-width mismatch (the gemma4-e4b-q4 8-bit-vs-4-bit case)', () => {
      const r = lintChatModelManifest(
        twoEngine(
          {
            residentBytes: 1,
            huggingfaceRepo: 'ggml-org/gemma-4-E4B-it-GGUF',
            quantization: 'Q8_0',
          },
          {
            residentBytes: 1,
            huggingfaceRepo: 'mlx-community/gemma-4-e4b-it-4bit',
            quantization: '4bit',
          },
        ),
      );
      expect(r.errors.map((f) => f.rule)).toContain('engine-quant-bits-mismatch');
    });

    it('accepts differently-labelled but equal widths (Q8_0 vs 8bit)', () => {
      const r = lintChatModelManifest(
        twoEngine(
          { residentBytes: 1, huggingfaceRepo: 'a/b-GGUF', quantization: 'Q8_0' },
          { residentBytes: 1, huggingfaceRepo: 'mlx-community/b-8bit', quantization: '8bit' },
        ),
      );
      expect(r.errors.map((f) => f.rule)).not.toContain('engine-quant-bits-mismatch');
    });

    it('flags QAT asymmetry at 4-bit (the gemma4-31b-q4 case)', () => {
      const r = lintChatModelManifest(
        twoEngine(
          {
            residentBytes: 1,
            huggingfaceRepo: 'unsloth/gemma-4-31B-it-qat-GGUF',
            quantization: 'UD-Q4_K_XL',
          },
          {
            residentBytes: 1,
            huggingfaceRepo: 'mlx-community/gemma-4-31b-it-4bit',
            quantization: '4bit',
          },
        ),
      );
      expect(r.errors.map((f) => f.rule)).toContain('engine-quant-qat-mismatch');
    });

    // QAT corrects quantization error, which is small by 8-bit — gating there
    // would fail CI over a difference that doesn't move quality.
    it('does NOT flag QAT asymmetry at 8-bit', () => {
      const r = lintChatModelManifest(
        twoEngine(
          {
            residentBytes: 1,
            huggingfaceRepo: 'ggml-org/gemma-4-E4B-it-GGUF',
            quantization: 'Q8_0',
          },
          {
            residentBytes: 1,
            huggingfaceRepo: 'mlx-community/gemma-4-E4B-it-qat-8bit',
            quantization: '8bit',
          },
        ),
      );
      expect(r.errors.map((f) => f.rule)).not.toContain('engine-quant-qat-mismatch');
    });

    it('warns on a vendor MLX format but does not gate (nvfp4 / MXFP4)', () => {
      const r = lintChatModelManifest(
        twoEngine(
          { residentBytes: 1, huggingfaceRepo: 'unsloth/x-qat-GGUF', quantization: 'UD-Q4_K_XL' },
          { residentBytes: 1, huggingfaceRepo: 'mlx-community/x-qat-nvfp4', quantization: 'nvfp4' },
        ),
      );
      expect(r.warnings.map((f) => f.rule)).toContain('mlx-nonstandard-quant-format');
      expect(r.errors.map((f) => f.rule)).not.toContain('mlx-nonstandard-quant-format');
    });

    it('is silent for a single-engine model', () => {
      const r = lintChatModelManifest(complete);
      expect(r.errors.map((f) => f.rule)).not.toContain('engine-quant-bits-mismatch');
      expect(r.warnings.map((f) => f.rule)).not.toContain('mlx-nonstandard-quant-format');
    });
  });
  describe('dropped tier defaults', () => {
    it('classifies tiers on the same boundaries as the service', () => {
      expect(tierForParams('3B')).toBe('tiny');
      expect(tierForParams('9B')).toBe('small');
      expect(tierForParams('27B')).toBe('medium');
      expect(tierForParams('284B')).toBe('large');
      // Gemma "E4B" effective-parameter labels behave like ~8B.
      expect(tierForParams('E4B')).toBe('small');
      expect(tierForParams(undefined)).toBe('tiny');
    });

    // Declaring `behaviors` replaces the tier list wholesale, so an omission
    // is a silent opt-out. Measured cost of losing just compact-tool-schemas
    // on a 71-tool surface: 98,394 -> 145,748 schema chars (~12K tokens/turn).
    it('warns about tier defaults a manifest opts out of, naming them', () => {
      const r = lintChatModelManifest({
        ...complete,
        parameterSize: '27B',
        behaviors: ['fabrication.detect-past-tense-no-tools'],
      });
      const f = r.warnings.find((w) => w.rule === 'drops-tier-default-behaviors');
      expect(f?.detail).toContain('mcp.compact-tool-schemas');
      expect(f?.detail).toContain('12K tokens');
      // Already declared, so it must not be listed as dropped.
      expect(f?.detail).not.toContain('fabrication.detect-past-tense-no-tools');
    });

    it('stays silent when the manifest re-declares the whole tier list', () => {
      const r = lintChatModelManifest({
        ...complete,
        parameterSize: '27B',
        behaviors: [
          'mcp.compact-tool-schemas',
          'fabrication.detect-past-tense-no-tools',
          'prompt.retrieval-first',
          'prompt.workspace-gestalt',
        ],
      });
      expect(r.warnings.map((w) => w.rule)).not.toContain('drops-tier-default-behaviors');
    });

    it('stays silent for a manifest with no behaviors (it inherits the defaults)', () => {
      const { behaviors: _drop, ...noBehaviors } = complete;
      const r = lintChatModelManifest({ ...noBehaviors, parameterSize: '27B' });
      expect(r.warnings.map((w) => w.rule)).not.toContain('drops-tier-default-behaviors');
    });
  });
});
