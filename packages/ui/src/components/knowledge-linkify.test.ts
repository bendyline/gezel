import { describe, expect, it } from 'vitest';
import { knowledgeRefFromHref, linkifyKnowledgeRefs } from './knowledge-linkify.js';

const uri = 'knowledge://bendyline/handboek/getting-started#chunk=0123456789abcdef0123456789abcdef';

describe('linkifyKnowledgeRefs', () => {
  it('links a bare citation and keeps the sentence punctuation outside it', () => {
    expect(linkifyKnowledgeRefs(`Gezel keeps work on disk (see ${uri}).`)).toBe(
      `Gezel keeps work on disk (see [handboek › getting started](${uri})).`,
    );
  });

  it('links a citation written as a code span', () => {
    expect(linkifyKnowledgeRefs(`Source: \`${uri}\``)).toBe(
      `Source: [handboek › getting started](${uri})`,
    );
  });

  it('leaves existing Markdown links, fenced code and malformed URIs alone', () => {
    const linked = `See [the guide](${uri}).`;
    expect(linkifyKnowledgeRefs(linked)).toBe(linked);
    const fenced = `\`\`\`\n${uri}\n\`\`\``;
    expect(linkifyKnowledgeRefs(fenced)).toBe(fenced);
    expect(linkifyKnowledgeRefs('knowledge://nope is not a citation')).toBe(
      'knowledge://nope is not a citation',
    );
  });

  it('reads a clicked citation back', () => {
    expect(knowledgeRefFromHref(uri)).toMatchObject({
      catalogId: 'handboek',
      documentId: 'getting-started',
    });
    expect(knowledgeRefFromHref('#artifact:notes.md')).toBeNull();
  });
});
