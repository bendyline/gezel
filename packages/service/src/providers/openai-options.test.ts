import { describe, expect, it } from 'vitest';
import {
  applyOpenAIModelContract,
  isOpenAIChatModel,
  isOpenAIReasoningModel,
  openAIDefaultReasoningEffort,
  openAIReasoningEfforts,
  supportedOpenAIEffort,
} from './openai-options.js';

describe('OpenAI reasoning contracts', () => {
  it.each([
    ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4', ['none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.1', ['none', 'low', 'medium', 'high']],
    ['gpt-5', ['minimal', 'low', 'medium', 'high']],
    ['o3', ['low', 'medium', 'high']],
  ])('recognizes %s as a reasoning model with its documented efforts', (model, efforts) => {
    expect(isOpenAIReasoningModel(model)).toBe(true);
    expect(openAIReasoningEfforts(model)).toEqual(efforts);
  });

  it('gives an unlisted GPT-6 revision the range every GPT-6 model accepts', () => {
    expect(openAIReasoningEfforts('gpt-6.2-luna')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(openAIDefaultReasoningEffort('gpt-6.2-luna')).toBe('medium');
  });

  it('leaves non-reasoning chat models alone', () => {
    expect(isOpenAIReasoningModel('gpt-4.1')).toBe(false);
    expect(openAIReasoningEfforts('gpt-4.1')).toBeUndefined();
  });

  it.each([
    ['gpt-6.1-sol', 'minimal', 'low'],
    ['gpt-6.1-sol', 'none', 'low'],
    ['gpt-6-luna', 'minimal', 'low'],
    ['gpt-6-luna', 'none', 'none'],
    ['gpt-5.5', 'max', 'xhigh'],
    ['gpt-6-astra', 'ultra', 'max'],
    ['gpt-6-astra', 'high', 'high'],
  ])('runs %s at the closest supported effort to %s', (model, requested, expected) => {
    expect(supportedOpenAIEffort(model, requested)).toBe(expected);
  });

  it('rejects an effort label no OpenAI surface uses', () => {
    expect(supportedOpenAIEffort('gpt-6.1-sol', 'typo')).toBeUndefined();
  });
});

describe('applyOpenAIModelContract', () => {
  it('clamps the effort and drops sampling a reasoning model rejects', () => {
    const request: Record<string, unknown> = {
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'minimal' },
      temperature: 0.7,
      top_p: 0.9,
    };
    applyOpenAIModelContract(request, 'gpt-6.1-sol');
    expect(request).toEqual({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' } });
  });

  it('drops sampling when the effort is left to a reasoning default', () => {
    const request: Record<string, unknown> = { temperature: 0.2 };
    applyOpenAIModelContract(request, 'gpt-6-luna');
    expect(request).toEqual({});
  });

  it('keeps sampling when reasoning is off', () => {
    const request: Record<string, unknown> = { reasoning: { effort: 'none' }, temperature: 0.2 };
    applyOpenAIModelContract(request, 'gpt-6-luna');
    expect(request).toEqual({ reasoning: { effort: 'none' }, temperature: 0.2 });
    const legacy: Record<string, unknown> = { temperature: 0.2 };
    applyOpenAIModelContract(legacy, 'gpt-5.4');
    expect(legacy).toEqual({ temperature: 0.2 });
  });

  it('falls back to the model default for an unknown effort label', () => {
    const request: Record<string, unknown> = { reasoning: { effort: 'typo' } };
    applyOpenAIModelContract(request, 'gpt-6-astra');
    expect(request).toEqual({});
  });

  it('does not touch a non-reasoning model', () => {
    const request: Record<string, unknown> = { temperature: 0.2 };
    applyOpenAIModelContract(request, 'gpt-4.1');
    expect(request).toEqual({ temperature: 0.2 });
  });
});

describe('isOpenAIChatModel', () => {
  it.each(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-cyber', 'o3', 'chatgpt-4o-latest'])(
    'lists %s',
    (id) => expect(isOpenAIChatModel(id)).toBe(true),
  );

  it.each([
    'gpt-image-2.5-flare',
    'gpt-realtime-2.1',
    'gpt-realtime-2.1-mini',
    'gpt-live-1',
    'gpt-4o-mini-tts',
    'gpt-transcribe',
    'gpt-realtime-whisper',
    'gpt-4o-audio-preview',
    'gpt-4o-search-preview',
    'text-embedding-3-large',
  ])('hides %s, which cannot hold a text conversation', (id) => {
    expect(isOpenAIChatModel(id)).toBe(false);
  });
});
