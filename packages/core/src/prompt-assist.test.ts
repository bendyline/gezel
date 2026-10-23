import { describe, expect, it } from 'vitest';
import { buildPromptAssistInput, parsePromptAssistReply } from './prompt-assist.js';

describe('buildPromptAssistInput', () => {
  it('asks for a tagged rewrite that keeps the facts', () => {
    const input = buildPromptAssistInput('clarify', 'can u make the deck for friday', {
      recipient: 'Ada',
      notes: ['Say how many slides'],
    });
    expect(input).toContain('about to send to Ada');
    expect(input).toContain('every name, number, date');
    expect(input).toContain('- Say how many slides');
    expect(input).toContain('<message>\ncan u make the deck for friday\n</message>');
  });

  it('gives the image model its guide and forbids invented content', () => {
    const input = buildPromptAssistInput('shape-image', 'three red cubes on a table', {
      imageGuide: 'Krea 2 Turbo reads plain descriptive sentences.',
    });
    expect(input).toContain(
      'The model that will draw it: Krea 2 Turbo reads plain descriptive sentences.',
    );
    expect(input).toContain('how many of each thing there are');
    expect(input).toContain('Add no objects, people, characters, words or quotation marks');
    expect(input).toContain('no tags for people (such as 1girl or 1boy) unless the request names');
  });
});

describe('parsePromptAssistReply', () => {
  it('reads the tagged rewrite, ignoring reasoning and fences', () => {
    expect(
      parsePromptAssistReply(
        'clarify',
        '<think>hmm</think>\n```\n<message>\nPlease build the deck by Friday.\n</message>\n```',
        'can u make the deck for friday',
      ),
    ).toEqual({ text: 'Please build the deck by Friday.' });
  });

  it('refuses an empty rewrite and marks an unchanged one', () => {
    expect(parsePromptAssistReply('proofread', '<message></message>', 'hi')).toBeNull();
    expect(parsePromptAssistReply('proofread', '<message>hi</message>', 'hi')).toEqual({
      text: 'hi',
      unchanged: true,
    });
  });

  it('reads review suggestions as a list', () => {
    expect(
      parsePromptAssistReply(
        'review',
        'Here you go:\n- Name the audience\n* Give a deadline\n',
        'x',
      ),
    ).toEqual({ suggestions: ['Name the audience', 'Give a deadline'] });
    expect(parsePromptAssistReply('review', 'Looks good.', 'x')).toBeNull();
  });
});
