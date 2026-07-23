import { describe, expect, it } from 'vitest';
import { extractMentionTokens, extractMentions, parseMentionId } from './mention-parse.js';

describe('extractMentions', () => {
  it('returns an empty array for drafts with no mentions', () => {
    expect(extractMentions('')).toEqual([]);
    expect(extractMentions('just regular text')).toEqual([]);
    expect(extractMentions('[a link](https://x.com), not a mention')).toEqual([]);
  });

  it('pulls one mention out', () => {
    expect(extractMentions('hey @[Leo](gezel:leo), look')).toEqual(['leo']);
  });

  it('dedups repeated mentions', () => {
    expect(
      extractMentions('@[Leo](gezel:leo) said @[Tess](gezel:tess) agrees — @[Leo](gezel:leo) too'),
    ).toEqual(['leo', 'tess']);
  });

  it('tolerates the backslash-escaped colon remark emits', () => {
    // `gezel\:leo` is what remark-stringify sometimes writes; round-tripping
    // through `parseMarkdown(stringifyMarkdown(x))` is idempotent, but the
    // markdown-on-the-wire can carry the escape.
    expect(extractMentions('hi @[Leo](gezel\\:leo)')).toEqual(['leo']);
  });

  it('ignores malformed mentions that are missing the gezel scheme', () => {
    expect(extractMentions('@[Leo](user:leo)')).toEqual([]);
    expect(extractMentions('@[Leo]()')).toEqual([]);
    expect(extractMentions('@ [Leo](gezel:leo)')).toEqual([]);
  });

  it('pulls multiple distinct mentions in document order', () => {
    const md = 'start @[A](gezel:a) then @[B](gezel:b) and @[C](gezel:c) end';
    expect(extractMentions(md)).toEqual(['a', 'b', 'c']);
  });

  it('preserves the project-tagged id verbatim on the wire', () => {
    // The Meester picker emits `gezel:mira?project=design-system` so
    // the same gezel can be addressed across multiple projects in one
    // draft. `extractMentions` must NOT collapse the suffix away —
    // the server-side fan-out parses it to route the message.
    expect(
      extractMentions(
        '@[Mira](gezel:mira?project=design-system) and @[Mira](gezel:mira?project=ops)',
      ),
    ).toEqual(['mira?project=design-system', 'mira?project=ops']);
  });
});

describe('extractMentionTokens', () => {
  it('returns id + label + rawId in document order', () => {
    expect(extractMentionTokens('ping @[Ambrose](gezel:ambrose) how?')).toEqual([
      { id: 'ambrose', label: 'Ambrose', rawId: 'ambrose' },
    ]);
  });

  it('dedups by raw id but keeps the first-seen label', () => {
    const md = '@[Leo](gezel:leo) and @[Tess](gezel:tess), also @[Leonardo](gezel:leo)';
    expect(extractMentionTokens(md)).toEqual([
      { id: 'leo', label: 'Leo', rawId: 'leo' },
      { id: 'tess', label: 'Tess', rawId: 'tess' },
    ]);
  });

  it('tolerates the backslash-escaped colon', () => {
    expect(extractMentionTokens('hi @[Leo](gezel\\:leo)')).toEqual([
      { id: 'leo', label: 'Leo', rawId: 'leo' },
    ]);
  });

  it('decodes the optional ?project= suffix into a structured projectId', () => {
    expect(extractMentionTokens('@[Mira](gezel:mira?project=design-system) ping')).toEqual([
      {
        id: 'mira',
        label: 'Mira',
        rawId: 'mira?project=design-system',
        projectId: 'design-system',
      },
    ]);
  });

  it('keeps two project-tagged mentions of the same gezel as separate tokens', () => {
    // Same gezel, different project context — the user is broadcasting
    // to Mira-on-A *and* Mira-on-B. The picker emits two distinct
    // entries; the parser must honor both rather than dedupe by id.
    const md = '@[Mira](gezel:mira?project=a) and @[Mira](gezel:mira?project=b)';
    expect(extractMentionTokens(md)).toEqual([
      { id: 'mira', label: 'Mira', rawId: 'mira?project=a', projectId: 'a' },
      { id: 'mira', label: 'Mira', rawId: 'mira?project=b', projectId: 'b' },
    ]);
  });
});

describe('parseMentionId', () => {
  it('returns the bare id unchanged when no suffix', () => {
    expect(parseMentionId('mira')).toEqual({ gezelId: 'mira' });
  });

  it('splits the project query suffix off', () => {
    expect(parseMentionId('mira?project=design-system')).toEqual({
      gezelId: 'mira',
      projectId: 'design-system',
    });
  });

  it('drops an unrecognized suffix that has no `project` param', () => {
    // Defensive — if a future picker adds another query key, the parser
    // shouldn't accidentally surface it as a project id.
    expect(parseMentionId('mira?other=value')).toEqual({ gezelId: 'mira' });
  });
});
