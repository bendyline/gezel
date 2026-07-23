import { describe, expect, it } from 'vitest';
import {
  checkStoryAnchors,
  checkStoryForm,
  countDialoguePassages,
  countProseParagraphs,
  storySniffResult,
} from './story-checks.ts';

const PROSE_PARAGRAPH =
  'The gatekeeper crossed the yard in the blue dark before dawn, boots creaking on the packed snow, and stood a while listening to the castle breathe around him before he touched the bolts.';

function makeStory(opts: { paragraphs?: number; dialogue?: number; title?: boolean } = {}): string {
  const { paragraphs = 24, dialogue = 4, title = true } = opts;
  const parts: string[] = [];
  if (title) parts.push('# A Story');
  for (let i = 0; i < paragraphs; i += 1) {
    parts.push(`${PROSE_PARAGRAPH} He counted the morning stars, and the ${i + 1}th bell rang.`);
  }
  for (let i = 0; i < dialogue; i += 1) {
    parts.push(`"Late again," she said, and he could not argue with the ${i + 1}th accusation.`);
  }
  return parts.join('\n\n');
}

describe('countProseParagraphs', () => {
  it('counts substantial blank-line-separated prose blocks, skipping headings/bullets/quotes', () => {
    const text = [
      '# Title',
      '',
      PROSE_PARAGRAPH,
      '',
      '- a bullet line that is quite long but still a bullet and therefore not a prose paragraph at all',
      '',
      '> a long blockquote that runs on past the length floor but should not be counted as story prose',
      '',
      'Too short.',
      '',
      PROSE_PARAGRAPH,
    ].join('\n');
    expect(countProseParagraphs(text)).toBe(2);
  });
});

describe('countDialoguePassages', () => {
  it('counts straight and curly double-quoted passages', () => {
    expect(countDialoguePassages('"One." said A. “Two,” said B. \'not this\'')).toBe(2);
  });
});

describe('checkStoryForm', () => {
  it('a well-formed story fires all six form signals', () => {
    const { signals, failures } = checkStoryForm(makeStory());
    expect(failures).toEqual([]);
    expect(signals).toEqual([
      'story-length',
      'title',
      'prose-form',
      'dialogue',
      'paragraphs',
      'no-cliche-opening',
    ]);
  });

  it('each failure message names the gate as its prefix', () => {
    const { failures } = checkStoryForm('no title, no story');
    for (const failure of failures) {
      expect(failure).toMatch(/^[a-z-]+: /);
    }
  });

  it('the cliché gate only inspects the opening — a later mention is fine', () => {
    const late = `${makeStory()}\n\n"Once upon a time," she scoffed, "is how liars start their stories and you know it."`;
    expect(checkStoryForm(late).signals).toContain('no-cliche-opening');
    const early = makeStory().replace(PROSE_PARAGRAPH, `Once upon a time, ${PROSE_PARAGRAPH}`);
    expect(checkStoryForm(early).failures.join(' ')).toMatch(/no-cliche-opening/);
  });
});

describe('checkStoryAnchors + storySniffResult', () => {
  const anchors = [
    { id: 'a', label: 'the letter a', pattern: /alpha/i },
    { id: 'b', label: 'the letter b', pattern: /beta/i },
  ];

  it('reports missing anchors by label and assembles missingRequiredSignals', () => {
    const story = makeStory().replace('morning stars', 'alpha stars');
    const anchor = checkStoryAnchors(story, anchors, 2, 'elements');
    expect(anchor.ok).toBe(false);
    expect(anchor.failure).toMatch(/the letter b/);
    const sniff = storySniffResult(checkStoryForm(story), anchor);
    expect(sniff.ok).toBe(false);
    expect(sniff.score).toBe(6);
    expect(sniff.missingRequiredSignals).toEqual(['elements']);
  });

  it('a quorum floor below the anchor count tolerates missing anchors', () => {
    const story = makeStory().replace('morning stars', 'alpha stars');
    const anchor = checkStoryAnchors(story, anchors, 1, 'elements');
    expect(anchor.ok).toBe(true);
    const sniff = storySniffResult(checkStoryForm(story), anchor);
    expect(sniff.ok).toBe(true);
    expect(sniff.signals).toContain('elements');
    expect(sniff.score).toBe(7);
  });
});
