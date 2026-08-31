import type { ChatModelTuning } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_TUNING_MAP,
  LLAMA_CPP_TUNING_MAP,
  MLX_TUNING_MAP,
  OLLAMA_BODY_TUNING_MAP,
  OLLAMA_OPTIONS_TUNING_MAP,
  OLLAMA_TUNING_MAP,
  OPENAI_TUNING_MAP,
  applyTuning,
  isReasoningEngaged,
  resolveTuning,
} from './tuning.js';

describe('resolveTuning', () => {
  it('returns empty blocks when nothing is set anywhere', () => {
    const out = resolveTuning({});
    expect(out.sampling).toEqual({});
    expect(out.reasoning).toEqual({});
    expect(out.output).toEqual({});
    expect(out.promptTags).toEqual({});
    expect(out.wasThinking).toBe(false);
  });

  it('takes catalog sampling when no override is set', () => {
    const catalog: ChatModelTuning = { sampling: { temperature: 0.7, topP: 0.9 } };
    const out = resolveTuning({ catalog });
    expect(out.sampling).toEqual({ temperature: 0.7, topP: 0.9 });
  });

  it('overrides only the fields the gezel sets — others fall through to catalog', () => {
    const catalog: ChatModelTuning = { sampling: { temperature: 0.7, topP: 0.9, topK: 40 } };
    const override: ChatModelTuning = { sampling: { temperature: 0.2 } };
    const out = resolveTuning({ catalog, override });
    expect(out.sampling).toEqual({ temperature: 0.2, topP: 0.9, topK: 40 });
  });

  it('install default sits between gezel override and catalog (gezel > install > catalog)', () => {
    const catalog: ChatModelTuning = { sampling: { temperature: 0.7, topP: 0.9, topK: 40 } };
    const installDefault: ChatModelTuning = { sampling: { temperature: 0.5, topP: 0.85 } };
    const override: ChatModelTuning = { sampling: { temperature: 0.2 } };
    // temperature: gezel wins (0.2). topP: install fills (0.85, beats catalog 0.9).
    // topK: install didn't set, falls through to catalog (40).
    const out = resolveTuning({ catalog, installDefault, override });
    expect(out.sampling).toEqual({ temperature: 0.2, topP: 0.85, topK: 40 });
  });

  it('install default applies without a gezel override', () => {
    const catalog: ChatModelTuning = { sampling: { temperature: 0.7 } };
    const installDefault: ChatModelTuning = { sampling: { temperature: 0.5, topP: 0.9 } };
    const out = resolveTuning({ catalog, installDefault });
    expect(out.sampling).toEqual({ temperature: 0.5, topP: 0.9 });
  });

  it('folds samplingWhenThinking on top of sampling when reasoning is engaged via enableThinking', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
      samplingWhenThinking: { temperature: 0.6, topP: 0.95 },
      reasoning: { enableThinking: true },
    };
    const out = resolveTuning({ catalog, styleReasoningFormat: 'think' });
    expect(out.wasThinking).toBe(true);
    expect(out.sampling).toEqual({ temperature: 0.6, topP: 0.95, topK: 20, minP: 0 });
  });

  it('does NOT fold samplingWhenThinking when reasoning is explicitly disabled', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7, topP: 0.8 },
      samplingWhenThinking: { temperature: 0.6, topP: 0.95 },
      reasoning: { enableThinking: false },
    };
    const out = resolveTuning({ catalog, styleReasoningFormat: 'think' });
    expect(out.wasThinking).toBe(false);
    expect(out.sampling).toEqual({ temperature: 0.7, topP: 0.8 });
  });

  it('engages thinking when reasoningEffort is set on a thinking-capable model', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      samplingWhenThinking: { temperature: 0.6 },
    };
    const out = resolveTuning({
      catalog,
      styleReasoningFormat: 'think',
      reasoningEffort: 'high',
    });
    expect(out.wasThinking).toBe(true);
    expect(out.sampling.temperature).toBe(0.6);
  });

  it('ignores reasoningEffort when the model has style.reasoningFormat: none', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      samplingWhenThinking: { temperature: 0.6 },
    };
    const out = resolveTuning({
      catalog,
      styleReasoningFormat: 'none',
      reasoningEffort: 'high',
    });
    expect(out.wasThinking).toBe(false);
    expect(out.sampling.temperature).toBe(0.7);
  });

  it('promotes thinking when an enable tag appears in the user prompt', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      samplingWhenThinking: { temperature: 0.6 },
      promptTags: { enableThinkingTag: '/think', disableThinkingTag: '/no_think' },
    };
    const out = resolveTuning({
      catalog,
      styleReasoningFormat: 'think',
      latestUserPrompt: 'Solve this carefully /think please',
    });
    expect(out.wasThinking).toBe(true);
  });

  it('disable tag wins over enable tag', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      samplingWhenThinking: { temperature: 0.6 },
      promptTags: { enableThinkingTag: '/think', disableThinkingTag: '/no_think' },
    };
    const out = resolveTuning({
      catalog,
      styleReasoningFormat: 'think',
      latestUserPrompt: '/think but actually /no_think',
    });
    expect(out.wasThinking).toBe(false);
  });

  it('merges promptTags from both catalog and override (override wins per-key)', () => {
    const catalog: ChatModelTuning = {
      promptTags: { enableThinkingTag: '/think', disableThinkingTag: '/no_think' },
    };
    const override: ChatModelTuning = {
      promptTags: { enableThinkingTag: '/reason' },
    };
    const out = resolveTuning({ catalog, override });
    expect(out.promptTags).toEqual({
      enableThinkingTag: '/reason',
      disableThinkingTag: '/no_think',
    });
  });
});

describe('resolveTuning — tuning profiles', () => {
  // Reusable Qwen-3.6-shaped catalog with a small profile set covering both
  // thinking and instruct kinds, plus the legacy samplingWhenThinking
  // overlay (kept on the manifest for models that don't ship profiles).
  const qwenCatalog: ChatModelTuning = {
    sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
    samplingWhenThinking: { temperature: 0.6, topP: 0.95 },
    reasoning: { enableThinking: true },
    profiles: {
      'thinking-general': {
        sampling: { temperature: 1.0, topP: 0.95, topK: 20, repetitionPenalty: 1.0 },
        reasoning: { enableThinking: true },
      },
      'thinking-coding': {
        sampling: { temperature: 0.6, topP: 0.95, topK: 20, repetitionPenalty: 1.0 },
        reasoning: { enableThinking: true },
      },
      instruct: {
        sampling: { temperature: 0.7, topP: 0.8, presencePenalty: 1.5 },
        reasoning: { enableThinking: false },
      },
    },
  };

  it('applies the requested profile as a layer over catalog base', () => {
    const out = resolveTuning({
      catalog: qwenCatalog,
      tuningProfileId: 'thinking-coding',
      styleReasoningFormat: 'think',
    });
    expect(out.sampling.temperature).toBe(0.6);
    expect(out.sampling.topP).toBe(0.95);
    expect(out.sampling.repetitionPenalty).toBe(1.0);
    expect(out.resolvedTuningProfile).toBe('thinking-coding');
  });

  it('gezel override wins over profile per-leaf', () => {
    const override: ChatModelTuning = { sampling: { temperature: 0.3 } };
    const out = resolveTuning({
      catalog: qwenCatalog,
      override,
      tuningProfileId: 'thinking-coding',
      styleReasoningFormat: 'think',
    });
    expect(out.sampling.temperature).toBe(0.3); // override beats profile's 0.6
    expect(out.sampling.topP).toBe(0.95); // profile still fills in unset fields
  });

  it('install default sits between profile and gezel override', () => {
    const installDefault: ChatModelTuning = { sampling: { temperature: 0.4 } };
    const out = resolveTuning({
      catalog: qwenCatalog,
      installDefault,
      tuningProfileId: 'thinking-coding',
      styleReasoningFormat: 'think',
    });
    expect(out.sampling.temperature).toBe(0.4); // install beats profile's 0.6
    expect(out.sampling.topP).toBe(0.95); // profile fills in
  });

  it('walks the fallback chain when the requested profile is not implemented', () => {
    // catalog only has thinking-general; we ask for thinking-coding which
    // canonically falls back to thinking-general → instruct.
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      profiles: {
        'thinking-general': { sampling: { temperature: 1.0 } },
      },
    };
    const out = resolveTuning({ catalog, tuningProfileId: 'thinking-coding' });
    expect(out.resolvedTuningProfile).toBe('thinking-general');
    expect(out.sampling.temperature).toBe(1.0);
  });

  it('falls through to base tuning when the chain has no match', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      profiles: { creative: { sampling: { temperature: 1.1 } } },
    };
    // thinking-coding chain: thinking-coding → thinking-general → instruct.
    // None match `creative`; resolver returns base tuning.
    const out = resolveTuning({ catalog, tuningProfileId: 'thinking-coding' });
    expect(out.resolvedTuningProfile).toBeUndefined();
    expect(out.sampling.temperature).toBe(0.7);
  });

  it('unknown (non-canonical) profile id is silently ignored', () => {
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      profiles: { 'thinking-general': { sampling: { temperature: 1.0 } } },
    };
    const out = resolveTuning({ catalog, tuningProfileId: 'made-up-id' });
    expect(out.resolvedTuningProfile).toBeUndefined();
    expect(out.sampling.temperature).toBe(0.7);
  });

  it('thinking-kind profile suppresses the samplingWhenThinking double-fold', () => {
    // Without profile suppression, thinking-coding's 0.6 would have
    // samplingWhenThinking's 0.6 also folded — same value here, but if
    // samplingWhenThinking had temperature: 0.5 it would clobber the
    // profile's 0.6 and we'd see 0.5. Pin samplingWhenThinking to a
    // distinct value to prove suppression.
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      samplingWhenThinking: { temperature: 0.5 }, // intentionally different
      profiles: {
        'thinking-coding': {
          sampling: { temperature: 0.6, topP: 0.95 },
          reasoning: { enableThinking: true },
        },
      },
    };
    const out = resolveTuning({
      catalog,
      tuningProfileId: 'thinking-coding',
      styleReasoningFormat: 'think',
    });
    // Profile wins; samplingWhenThinking does NOT clobber to 0.5.
    expect(out.sampling.temperature).toBe(0.6);
    expect(out.wasThinking).toBe(true); // still in thinking mode
  });

  it('instruct-kind profile lets samplingWhenThinking fold normally when reasoning is engaged', () => {
    // The `instruct` profile is kind: 'instruct', so the suppression does
    // NOT fire. If reasoning is somehow engaged (e.g. styleReasoningFormat
    // + reasoningEffort), the legacy samplingWhenThinking fold still runs.
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      samplingWhenThinking: { temperature: 0.5 },
      reasoning: { enableThinking: true },
      profiles: {
        instruct: {
          // No reasoning override here — the merged tuning ends up with
          // enableThinking: true from catalog, so reasoning still engages.
          sampling: { temperature: 0.8 },
        },
      },
    };
    const out = resolveTuning({
      catalog,
      tuningProfileId: 'instruct',
      styleReasoningFormat: 'think',
    });
    expect(out.wasThinking).toBe(true);
    // samplingWhenThinking (0.5) folds on top of profile sampling (0.8).
    expect(out.sampling.temperature).toBe(0.5);
  });

  it('no profile requested — falls back to the app default (thinking-general)', () => {
    // With no per-gezel or install pick, the resolver applies the
    // app-wide default `thinking-general`. This model declares it, so its
    // sampling (temperature 1.0) wins and, being a thinking-kind profile,
    // the legacy samplingWhenThinking fold is suppressed.
    const out = resolveTuning({
      catalog: qwenCatalog,
      styleReasoningFormat: 'think',
    });
    expect(out.wasThinking).toBe(true);
    expect(out.resolvedTuningProfile).toBe('thinking-general');
    expect(out.sampling).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 20,
      repetitionPenalty: 1,
      minP: 0,
    });
  });

  it('no profile requested + model declares no matching default — base tuning applies', () => {
    // A model with profiles but none in thinking-general's fallback chain
    // (thinking-general → instruct) gets neither; base tuning + the legacy
    // samplingWhenThinking fold apply, exactly as before the default landed.
    const catalogNoDefault: ChatModelTuning = {
      sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
      samplingWhenThinking: { temperature: 0.6, topP: 0.95 },
      reasoning: { enableThinking: true },
      profiles: {
        creative: { sampling: { temperature: 1.2 } },
      },
    };
    const out = resolveTuning({ catalog: catalogNoDefault, styleReasoningFormat: 'think' });
    expect(out.wasThinking).toBe(true);
    expect(out.resolvedTuningProfile).toBeUndefined();
    expect(out.sampling).toEqual({ temperature: 0.6, topP: 0.95, topK: 20, minP: 0 });
  });

  it('profile sets reasoning.enableThinking which overrides catalog', () => {
    const out = resolveTuning({
      catalog: qwenCatalog,
      tuningProfileId: 'instruct',
      styleReasoningFormat: 'think',
    });
    // instruct profile flips enableThinking to false.
    expect(out.reasoning.enableThinking).toBe(false);
    expect(out.wasThinking).toBe(false);
    // samplingWhenThinking does NOT apply because reasoning is disabled.
    expect(out.sampling.temperature).toBe(0.7);
    expect(out.sampling.presencePenalty).toBe(1.5);
  });

  it('install-default profile applies when no per-gezel profile is set', () => {
    const out = resolveTuning({
      catalog: qwenCatalog,
      installDefaultProfileId: 'thinking-coding',
      styleReasoningFormat: 'think',
    });
    expect(out.resolvedTuningProfile).toBe('thinking-coding');
    expect(out.sampling.temperature).toBe(0.6);
    expect(out.sampling.topP).toBe(0.95);
  });

  it('per-gezel profile wins over install-default profile', () => {
    const out = resolveTuning({
      catalog: qwenCatalog,
      tuningProfileId: 'instruct',
      installDefaultProfileId: 'thinking-coding',
      styleReasoningFormat: 'think',
    });
    expect(out.resolvedTuningProfile).toBe('instruct');
    // instruct's sampling — temp 0.7, presencePenalty 1.5 — not coding's 0.6.
    expect(out.sampling.temperature).toBe(0.7);
    expect(out.sampling.presencePenalty).toBe(1.5);
  });

  it('install-default profile walks the canonical fallback chain', () => {
    // Model only declares thinking-general; install picks thinking-coding,
    // which canonically falls back to thinking-general.
    const catalog: ChatModelTuning = {
      sampling: { temperature: 0.7 },
      profiles: {
        'thinking-general': { sampling: { temperature: 1.0 } },
      },
    };
    const out = resolveTuning({ catalog, installDefaultProfileId: 'thinking-coding' });
    expect(out.resolvedTuningProfile).toBe('thinking-general');
    expect(out.sampling.temperature).toBe(1.0);
  });
});

describe('isReasoningEngaged', () => {
  it('false when style.reasoningFormat is none regardless of other signals', () => {
    expect(
      isReasoningEngaged({
        tuning: { reasoning: { enableThinking: true } },
        styleReasoningFormat: 'none',
      }),
    ).toBe(false);
  });

  it('explicit enableThinking=true beats absent style hint', () => {
    expect(
      isReasoningEngaged({
        tuning: { reasoning: { enableThinking: true } },
      }),
    ).toBe(true);
  });
});

describe('applyTuning — ollama (sampling lives under options, format/think at body root)', () => {
  it('options map writes sampling fields into the dict it targets', () => {
    const options: Record<string, unknown> = {};
    applyTuning(
      options,
      resolveTuning({ catalog: { sampling: { temperature: 0.7, topP: 0.9, topK: 40, seed: 42 } } }),
      OLLAMA_OPTIONS_TUNING_MAP,
    );
    expect(options).toEqual({ temperature: 0.7, top_p: 0.9, top_k: 40, seed: 42 });
  });

  it('body map translates response_format: json_object → format: "json"', () => {
    const body: Record<string, unknown> = {};
    applyTuning(
      body,
      resolveTuning({ catalog: { output: { responseFormat: 'json_object' } } }),
      OLLAMA_BODY_TUNING_MAP,
    );
    expect(body.format).toBe('json');
  });

  it('body map writes enable_thinking → top-level `think`', () => {
    const body: Record<string, unknown> = {};
    applyTuning(
      body,
      resolveTuning({ catalog: { reasoning: { enableThinking: true } } }),
      OLLAMA_BODY_TUNING_MAP,
    );
    expect(body.think).toBe(true);
  });

  it('options map drops DRY/XTC silently — Ollama has no equivalent', () => {
    const options: Record<string, unknown> = {};
    applyTuning(
      options,
      resolveTuning({
        catalog: {
          sampling: {
            dry: { multiplier: 0.8, allowedLength: 2 },
            xtc: { probability: 0.5, threshold: 0.1 },
          },
        },
      }),
      OLLAMA_OPTIONS_TUNING_MAP,
    );
    expect(options.dry_multiplier).toBeUndefined();
    expect(options.xtc_probability).toBeUndefined();
  });

  it('back-compat alias OLLAMA_TUNING_MAP equals OLLAMA_OPTIONS_TUNING_MAP', () => {
    expect(OLLAMA_TUNING_MAP).toBe(OLLAMA_OPTIONS_TUNING_MAP);
  });
});

describe('applyTuning — llama-cpp', () => {
  it('expands DRY into three separate fields', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: { sampling: { dry: { multiplier: 0.8, base: 1.75, allowedLength: 2 } } },
      }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.dry_multiplier).toBe(0.8);
    expect(target.dry_base).toBe(1.75);
    expect(target.dry_allowed_length).toBe(2);
  });

  it('wires grammar through as a top-level field', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { output: { grammar: 'root ::= "yes"' } } }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.grammar).toBe('root ::= "yes"');
  });

  it('wires json_schema as a top-level body field', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { output: { jsonSchema: schema } } }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.json_schema).toEqual(schema);
  });

  it('threads enable_thinking through chat_template_kwargs', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { reasoning: { enableThinking: true } } }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('does NOT thread reasoning.thinkingBudget through the request body — llama-server takes it as a launch-time CLI flag (--reasoning-budget) only, so the body writer is null and the supervisor reads it directly from the catalog', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: { reasoning: { enableThinking: true, thinkingBudget: 2048 } },
      }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(target.reasoning_budget_tokens).toBeUndefined();
  });

  it('forwards manifest-declared reasoning.templateKwargs verbatim — the model names its own control (Muse Glimmer reads reasoning_strength, GPT-OSS reads reasoning_effort)', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: { reasoning: { templateKwargs: { reasoning_strength: 'high' } } },
      }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.chat_template_kwargs).toEqual({ reasoning_strength: 'high' });
  });

  it('merges templateKwargs alongside enable_thinking rather than replacing the object', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: {
          reasoning: { enableThinking: true, templateKwargs: { reasoning_strength: 'xhigh' } },
        },
      }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_strength: 'xhigh',
    });
  });

  it('lets a tuning profile override reasoning depth per-request — the reason this lives under `reasoning` and not `engine`', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: {
          reasoning: { templateKwargs: { reasoning_strength: 'high' } },
          profiles: {
            instruct: { reasoning: { templateKwargs: { reasoning_strength: 'low' } } },
          },
        },
        tuningProfileId: 'instruct',
      }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(target.chat_template_kwargs).toEqual({ reasoning_strength: 'low' });
  });

  it('resolves the canonical thinking-deep profile as an opt-in effort override', () => {
    const target: Record<string, unknown> = {};
    const resolved = resolveTuning({
      catalog: {
        reasoning: {
          enableThinking: true,
          templateKwargs: { reasoning_effort: 'medium' },
        },
        profiles: {
          'thinking-general': {
            reasoning: { templateKwargs: { reasoning_effort: 'medium' } },
          },
          'thinking-deep': {
            reasoning: { templateKwargs: { reasoning_effort: 'xhigh' } },
          },
        },
      },
      tuningProfileId: 'thinking-deep',
    });
    applyTuning(target, resolved, LLAMA_CPP_TUNING_MAP);
    expect(resolved.resolvedTuningProfile).toBe('thinking-deep');
    expect(target.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: 'xhigh',
    });
  });

  it('drops templateKwargs on cloud providers, which have no chat template to parameterize', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: { reasoning: { templateKwargs: { reasoning_strength: 'high' } } },
      }),
      OPENAI_TUNING_MAP,
    );
    expect(target.chat_template_kwargs).toBeUndefined();
  });
});

describe('applyTuning — mlx', () => {
  it('keeps the historical Gemma-family defaults parseable (temp=1.0/topP=0.95/topK=64/repPenalty=1.1)', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: {
          sampling: {
            temperature: 1.0,
            topP: 0.95,
            topK: 64,
            repetitionPenalty: 1.1,
            repetitionContext: 20,
          },
        },
      }),
      MLX_TUNING_MAP,
    );
    expect(target).toMatchObject({
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64,
      repetition_penalty: 1.1,
      repetition_context_size: 20,
    });
  });

  it('drops frequency/presence penalty — MLX has only repetition_penalty', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { sampling: { frequencyPenalty: 0.5, presencePenalty: 0.1 } } }),
      MLX_TUNING_MAP,
    );
    expect(target.frequency_penalty).toBeUndefined();
    expect(target.presence_penalty).toBeUndefined();
  });
});

describe('applyTuning — anthropic', () => {
  it('maps reasoning.effort=high → thinking.budget_tokens=24576', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { reasoning: { effort: 'high' } } }),
      ANTHROPIC_TUNING_MAP,
    );
    expect(target.thinking).toEqual({ type: 'enabled', budget_tokens: 24_576 });
  });

  it('thinkingBudget wins over effort when both are set (budget written first, effort skipped)', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: { reasoning: { effort: 'low', thinkingBudget: 16_384 } },
      }),
      ANTHROPIC_TUNING_MAP,
    );
    expect(target.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });
  });

  it("drops min_p / seed / penalties — Anthropic doesn't support them", () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({
        catalog: {
          sampling: { minP: 0, seed: 42, frequencyPenalty: 0.5, presencePenalty: 0.1 },
        },
      }),
      ANTHROPIC_TUNING_MAP,
    );
    expect(target.min_p).toBeUndefined();
    expect(target.seed).toBeUndefined();
    expect(target.frequency_penalty).toBeUndefined();
    expect(target.presence_penalty).toBeUndefined();
  });
});

describe('applyTuning — openai', () => {
  it('writes reasoning.effort as reasoning: { effort }', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { reasoning: { effort: 'medium' } } }),
      OPENAI_TUNING_MAP,
    );
    expect(target.reasoning).toEqual({ effort: 'medium' });
  });

  it('wraps json_schema in the OpenAI strict-mode envelope', () => {
    const schema = { type: 'object', properties: {} };
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { output: { jsonSchema: schema } } }),
      OPENAI_TUNING_MAP,
    );
    expect(target.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema },
    });
  });

  it('drops top_k and min_p — OpenAI Responses API has neither', () => {
    const target: Record<string, unknown> = {};
    applyTuning(
      target,
      resolveTuning({ catalog: { sampling: { topK: 40, minP: 0 } } }),
      OPENAI_TUNING_MAP,
    );
    expect(target.top_k).toBeUndefined();
    expect(target.min_p).toBeUndefined();
  });
});

describe('Round-trip — Qwen thinking-mode override lands in llama-cpp request body', () => {
  // The headline scenario from the plan: a Qwen catalog entry declares
  // `sampling` for non-thinking and `samplingWhenThinking` for thinking;
  // when reasoning is engaged, the thinking values must appear in the
  // final llama-cpp request body.
  it('emits temp=0.6, top_p=0.95 when reasoning is on; temp=0.7, top_p=0.8 otherwise', () => {
    const qwenCatalog: ChatModelTuning = {
      sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
      samplingWhenThinking: { temperature: 0.6, topP: 0.95 },
      reasoning: { enableThinking: true },
      promptTags: { enableThinkingTag: '/think', disableThinkingTag: '/no_think' },
    };
    const thinkingBody: Record<string, unknown> = {};
    applyTuning(
      thinkingBody,
      resolveTuning({ catalog: qwenCatalog, styleReasoningFormat: 'think' }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(thinkingBody).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
    });

    const nonThinkingBody: Record<string, unknown> = {};
    applyTuning(
      nonThinkingBody,
      resolveTuning({
        catalog: { ...qwenCatalog, reasoning: { enableThinking: false } },
        styleReasoningFormat: 'think',
      }),
      LLAMA_CPP_TUNING_MAP,
    );
    expect(nonThinkingBody).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
    });
  });
});

describe('resolveTuning — suggested (role/template) profile', () => {
  // A model implementing the canonical profiles, with distinct temps so
  // we can tell which layer won.
  const catalog: ChatModelTuning = {
    sampling: { temperature: 1.0 },
    profiles: {
      'thinking-general': { sampling: { temperature: 0.9 } },
      'thinking-precise': { sampling: { temperature: 0.3 } },
      'thinking-coding': { sampling: { temperature: 0.6 } },
    },
  };

  it('uses the suggested profile when the user has expressed no preference', () => {
    const out = resolveTuning({ catalog, suggestedProfileId: 'thinking-precise' });
    expect(out.resolvedTuningProfile).toBe('thinking-precise');
    expect(out.sampling.temperature).toBe(0.3);
  });

  it('install preset (explicit) beats the suggested profile', () => {
    const out = resolveTuning({
      catalog,
      installDefaultProfileId: 'thinking-coding',
      suggestedProfileId: 'thinking-precise',
    });
    expect(out.resolvedTuningProfile).toBe('thinking-coding');
    expect(out.sampling.temperature).toBe(0.6);
  });

  it('per-gezel pick (explicit) beats the suggested profile', () => {
    const out = resolveTuning({
      catalog,
      tuningProfileId: 'thinking-coding',
      suggestedProfileId: 'thinking-precise',
    });
    expect(out.resolvedTuningProfile).toBe('thinking-coding');
    expect(out.sampling.temperature).toBe(0.6);
  });

  it('suggested profile beats the app-wide default when nothing explicit is set', () => {
    // Without any suggestion this model would resolve to thinking-general
    // (the DEFAULT_TUNING_PROFILE_ID). The suggestion overrides that.
    const withSuggestion = resolveTuning({ catalog, suggestedProfileId: 'thinking-precise' });
    expect(withSuggestion.resolvedTuningProfile).toBe('thinking-precise');
    const withoutSuggestion = resolveTuning({ catalog });
    expect(withoutSuggestion.resolvedTuningProfile).toBe('thinking-general');
  });
});

describe('resolveTuning — profile maxTokens floor', () => {
  // A profile is a behavioral preset; `maxTokens` is a truncation point,
  // not a behavior. 33 shipped manifests author `thinking-precise` below
  // their own base, and that profile is what the Reviewer role selects.
  const qwenShaped: ChatModelTuning = {
    sampling: { temperature: 1, topP: 0.95, maxTokens: 12_288 },
    profiles: {
      'thinking-precise': { sampling: { temperature: 0.6, maxTokens: 6_144 } },
      'thinking-coding': { sampling: { temperature: 1, maxTokens: 16_384 } },
    },
  };

  it('raises a profile cap that sits below the model base back to the base', () => {
    const out = resolveTuning({
      catalog: qwenShaped,
      suggestedProfileId: 'thinking-precise',
    });
    expect(out.resolvedTuningProfile).toBe('thinking-precise');
    expect(out.sampling.maxTokens).toBe(12_288);
    // Everything else the profile sets still applies.
    expect(out.sampling.temperature).toBe(0.6);
  });

  it('leaves a profile cap ABOVE the model base alone', () => {
    const out = resolveTuning({ catalog: qwenShaped, suggestedProfileId: 'thinking-coding' });
    expect(out.sampling.maxTokens).toBe(16_384);
  });

  it('never overrides an explicit per-gezel maxTokens, in either direction', () => {
    const out = resolveTuning({
      catalog: qwenShaped,
      suggestedProfileId: 'thinking-precise',
      override: { sampling: { maxTokens: 2_048 } },
    });
    expect(out.sampling.maxTokens).toBe(2_048);
  });

  it('never overrides an install-wide preset maxTokens', () => {
    const out = resolveTuning({
      catalog: qwenShaped,
      suggestedProfileId: 'thinking-precise',
      installDefault: { sampling: { maxTokens: 4_096 } },
    });
    expect(out.sampling.maxTokens).toBe(4_096);
  });

  it('leaves an instruct-kind profile cap alone — a small ceiling is that mode', () => {
    const out = resolveTuning({
      catalog: {
        sampling: { temperature: 1, maxTokens: 8_192 },
        profiles: { terse: { sampling: { maxTokens: 1_024 } } },
      },
      suggestedProfileId: 'terse',
    });
    expect(out.sampling.maxTokens).toBe(1_024);
  });

  it('is a no-op when the model declares no base maxTokens', () => {
    const out = resolveTuning({
      catalog: {
        sampling: { temperature: 1 },
        profiles: { 'thinking-precise': { sampling: { maxTokens: 6_144 } } },
      },
      suggestedProfileId: 'thinking-precise',
    });
    expect(out.sampling.maxTokens).toBe(6_144);
  });
});
