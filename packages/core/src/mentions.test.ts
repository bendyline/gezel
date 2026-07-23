import { describe, expect, it } from 'vitest';
import {
  extractGezelMentionTokens,
  extractGezelMentions,
  parseGezelMentionId,
  stripGezelMentions,
} from './mentions.js';

describe('extractGezelMentions', () => {
  it('returns an empty array for drafts with no mentions', () => {
    expect(extractGezelMentions('')).toEqual([]);
    expect(extractGezelMentions('just regular text')).toEqual([]);
    expect(extractGezelMentions('[a link](https://x.com), not a mention')).toEqual([]);
  });

  it('pulls mentions in document order and dedups by raw id', () => {
    expect(
      extractGezelMentions(
        '@[Leo](gezel:leo) said @[Tess](gezel:tess) agrees, @[Leo](gezel:leo) too',
      ),
    ).toEqual(['leo', 'tess']);
  });

  it('tolerates the backslash-escaped colon remark emits', () => {
    expect(extractGezelMentions('hi @[Leo](gezel\\:leo)')).toEqual(['leo']);
  });

  it('preserves project-tagged ids verbatim on the wire', () => {
    expect(
      extractGezelMentions(
        '@[Mira](gezel:mira?project=design-system) and @[Mira](gezel:mira?project=ops)',
      ),
    ).toEqual(['mira?project=design-system', 'mira?project=ops']);
  });

  it('ignores malformed mentions that are missing the gezel scheme', () => {
    expect(extractGezelMentions('@[Leo](user:leo)')).toEqual([]);
    expect(extractGezelMentions('@[Leo]()')).toEqual([]);
    expect(extractGezelMentions('@ [Leo](gezel:leo)')).toEqual([]);
  });
});
describe('extractGezelMentionTokens', () => {
  it('returns id, label, raw id, and project override', () => {
    expect(extractGezelMentionTokens('@[Mira](gezel:mira?project=design-system) ping')).toEqual([
      {
        id: 'mira',
        label: 'Mira',
        rawId: 'mira?project=design-system',
        projectId: 'design-system',
      },
    ]);
  });

  it('keeps project-tagged mentions for the same gezel separate', () => {
    const md = '@[Mira](gezel:mira?project=a) and @[Mira](gezel:mira?project=b)';
    expect(extractGezelMentionTokens(md)).toEqual([
      { id: 'mira', label: 'Mira', rawId: 'mira?project=a', projectId: 'a' },
      { id: 'mira', label: 'Mira', rawId: 'mira?project=b', projectId: 'b' },
    ]);
  });
});

describe('parseGezelMentionId', () => {
  it('returns the bare id unchanged when no suffix exists', () => {
    expect(parseGezelMentionId('mira')).toEqual({ gezelId: 'mira' });
  });

  it('splits the project query suffix off', () => {
    expect(parseGezelMentionId('mira?project=design-system')).toEqual({
      gezelId: 'mira',
      projectId: 'design-system',
    });
  });

  it('drops an unrecognized suffix that has no project param', () => {
    expect(parseGezelMentionId('mira?other=value')).toEqual({ gezelId: 'mira' });
  });
});

describe('stripGezelMentions', () => {
  it('removes mentions and collapses whitespace', () => {
    expect(stripGezelMentions('@[A](gezel:a) and @[B](gezel:b) sketch a house')).toBe(
      'and sketch a house',
    );
  });

  it('does not strip @ signs that are not gezel mentions', () => {
    expect(stripGezelMentions('email me @ user@example.com please')).toBe(
      'email me @ user@example.com please',
    );
  });
});
