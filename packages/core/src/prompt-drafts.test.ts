import { describe, expect, it } from 'vitest';
import {
  derivePromptDraftTitle,
  formatPromptDraftId,
  isPromptDraftId,
  parsePromptDraftId,
  promptDraftFilesArtifactDir,
  promptDraftFilesRefPrefix,
  promptDraftMessageArtifactPath,
  rewritePromptDraftFileRefs,
} from './prompt-drafts.js';

describe('prompt draft ids', () => {
  it('formats a local calendar date with a zero-padded sequence', () => {
    expect(formatPromptDraftId(new Date(2026, 8, 3), 7)).toBe('2026-09-03-0007');
    expect(formatPromptDraftId(new Date(2026, 0, 1), 1)).toBe('2026-01-01-0001');
  });

  it('keeps growing past four digits without losing ordering', () => {
    const id = formatPromptDraftId(new Date(2026, 8, 3), 12345);
    expect(id).toBe('2026-09-03-12345');
    expect(parsePromptDraftId(id)).toEqual({ date: '2026-09-03', seq: 12345 });
  });

  it('round-trips through parse', () => {
    expect(parsePromptDraftId('2026-09-03-0007')).toEqual({ date: '2026-09-03', seq: 7 });
  });

  it('rejects anything that is not the canonical shape', () => {
    for (const bad of ['2026-9-3-1', '2026-09-03-001', 'prompts', '../x', '', 'draft-1']) {
      expect(isPromptDraftId(bad)).toBe(false);
      expect(parsePromptDraftId(bad)).toBeNull();
    }
  });
});

describe('prompt draft paths', () => {
  it('builds artifacts-relative paths without a leading artifacts/', () => {
    expect(promptDraftMessageArtifactPath('2026-09-03-0001')).toBe(
      'prompts/2026-09-03-0001/message.md',
    );
    expect(promptDraftFilesArtifactDir('2026-09-03-0001')).toBe(
      'prompts/2026-09-03-0001/message_files',
    );
  });

  it('builds the project-relative ref prefix a sent message carries', () => {
    expect(promptDraftFilesRefPrefix('2026-09-03-0001')).toBe(
      'artifacts/prompts/2026-09-03-0001/message_files/',
    );
  });
});

describe('rewritePromptDraftFileRefs', () => {
  const id = '2026-09-03-0001';
  const prefix = `artifacts/prompts/${id}/message_files/`;

  it('rewrites image and link destinations', () => {
    expect(rewritePromptDraftFileRefs('![shot](message_files/a.png)', id)).toBe(
      `![shot](${prefix}a.png)`,
    );
    expect(rewritePromptDraftFileRefs('[spec](message_files/spec.pdf)', id)).toBe(
      `[spec](${prefix}spec.pdf)`,
    );
  });

  it('handles the dot-slash and angle-bracket destination forms', () => {
    expect(rewritePromptDraftFileRefs('![a](./message_files/a.png)', id)).toBe(
      `![a](${prefix}a.png)`,
    );
    expect(rewritePromptDraftFileRefs('![a](<message_files/my shot.png>)', id)).toBe(
      `![a](<${prefix}my shot.png>)`,
    );
  });

  it('rewrites HTML src and href attributes', () => {
    expect(rewritePromptDraftFileRefs('<img src="message_files/a.png">', id)).toBe(
      `<img src="${prefix}a.png">`,
    );
    expect(rewritePromptDraftFileRefs("<a href='message_files/b.pdf'>b</a>", id)).toBe(
      `<a href='${prefix}b.pdf'>b</a>`,
    );
  });

  it('rewrites every reference in a document', () => {
    const out = rewritePromptDraftFileRefs(
      'one ![a](message_files/a.png) two ![b](message_files/b.png)',
      id,
    );
    expect(out).toBe(`one ![a](${prefix}a.png) two ![b](${prefix}b.png)`);
  });

  it('leaves references that already resolve alone', () => {
    for (const ref of [
      '![a](attachments/a.png)',
      '![a](artifacts/generated/a.png)',
      '![a](images/a.png)',
      '![a](https://example.com/message_files/a.png)',
      '![a](data:image/png;base64,AAA)',
      '![a](/message_files/a.png)',
      '![a](foo/message_files/a.png)',
    ]) {
      expect(rewritePromptDraftFileRefs(ref, id)).toBe(ref);
    }
  });

  it('preserves the destination bytes after the prefix', () => {
    const out = rewritePromptDraftFileRefs('![a](message_files/my%20shot%20(1).png)', id);
    expect(out).toBe(`![a](${prefix}my%20shot%20(1).png)`);
  });

  it('is idempotent', () => {
    const once = rewritePromptDraftFileRefs('![a](message_files/a.png)', id);
    expect(rewritePromptDraftFileRefs(once, id)).toBe(once);
  });

  it('returns the input untouched when there is nothing to rewrite', () => {
    expect(rewritePromptDraftFileRefs('plain text', id)).toBe('plain text');
  });
});

describe('rewritePromptDraftFileRefs and code fences', () => {
  const id = '2026-09-03-0001';
  const prefix = `artifacts/prompts/${id}/message_files/`;
  const BACKTICKS = '```';
  const TILDES = '~~~';

  it('leaves prose and fenced code untouched', () => {
    const doc = [
      'Files live in message_files/ next to the draft.',
      '',
      `${BACKTICKS}md`,
      '![example](message_files/a.png)',
      BACKTICKS,
      '',
      TILDES,
      '[x](message_files/b.png)',
      TILDES,
    ].join('\n');
    expect(rewritePromptDraftFileRefs(doc, id)).toBe(doc);
  });

  it('resumes rewriting after a fence closes', () => {
    const doc = [
      BACKTICKS,
      '![in](message_files/a.png)',
      BACKTICKS,
      '![out](message_files/b.png)',
    ].join('\n');
    expect(rewritePromptDraftFileRefs(doc, id)).toBe(
      [BACKTICKS, '![in](message_files/a.png)', BACKTICKS, `![out](${prefix}b.png)`].join('\n'),
    );
  });
});

describe('derivePromptDraftTitle', () => {
  it('uses the first line that says something', () => {
    expect(derivePromptDraftTitle('\n\n# Rework the onboarding\n\nbody')).toBe(
      'Rework the onboarding',
    );
    expect(derivePromptDraftTitle('> quoted opener')).toBe('quoted opener');
    expect(derivePromptDraftTitle('- first bullet')).toBe('first bullet');
  });

  it('shows the words rather than the markup for a draft that opens with media', () => {
    expect(derivePromptDraftTitle('![the mock](message_files/a.png)')).toBe('the mock');
    expect(derivePromptDraftTitle('see [the spec](message_files/s.pdf)')).toBe('see the spec');
  });

  it('collapses whitespace and truncates', () => {
    expect(derivePromptDraftTitle('a   b\tc')).toBe('a b c');
    const long = 'x'.repeat(200);
    const title = derivePromptDraftTitle(long, 20);
    expect(title).toHaveLength(20);
    expect(title.endsWith('…')).toBe(true);
  });

  it('is empty for an empty draft', () => {
    expect(derivePromptDraftTitle('')).toBe('');
    expect(derivePromptDraftTitle('\n \n\t\n')).toBe('');
  });
});
