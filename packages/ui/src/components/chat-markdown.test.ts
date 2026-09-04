import { parseMarkdown } from '@bendyline/squisq/markdown';
import { describe, expect, it } from 'vitest';
import { markdownToChatDoc } from './chat-markdown.js';

describe('markdownToChatDoc', () => {
  it('keeps a year-bearing list as a list instead of promoting it to a centered statistic', () => {
    const doc = markdownToChatDoc(
      parseMarkdown(
        [
          '### Phase 1: Early War (1337–1360)',
          '',
          '- **Battle of Crécy** (1346): A decisive English victory',
          '- **Battle of Agincourt** (1415): Another major English victory',
          '- The French eventually lost Aquitaine',
        ].join('\n'),
      ),
      { articleId: 'gezel-chat' },
    );

    expect(doc.blocks[0]).toMatchObject({
      autoTemplate: true,
      template: 'list',
      templateData: {
        title: 'Phase 1: Early War (1337–1360)',
        items: [
          'Battle of Crécy (1346): A decisive English victory',
          'Battle of Agincourt (1415): Another major English victory',
          'The French eventually lost Aquitaine',
        ],
      },
    });
  });

  it('retains automatic statistic treatments when the body is actually a statistic', () => {
    const doc = markdownToChatDoc(parseMarkdown('## Adoption\n\n**42%** of teams adopted it.'));

    expect(doc.blocks[0]).toMatchObject({ autoTemplate: true, template: 'statHighlight' });
  });

  it('respects an explicitly authored statistic treatment', () => {
    const doc = markdownToChatDoc(
      parseMarkdown('## Phase 1 {[statHighlight]}\n\n- 42% adopted it\n- 58% did not'),
    );

    expect(doc.blocks[0]).toMatchObject({ template: 'statHighlight' });
    expect(doc.blocks[0]?.autoTemplate).toBeUndefined();
  });
});
