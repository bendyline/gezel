import { parseMarkdown } from '@bendyline/squisq/markdown';
import { describe, expect, it } from 'vitest';
import { escapeCurrencyDollars, markdownToChatDoc, prepareChatMarkdown } from './chat-markdown.js';

describe('escapeCurrencyDollars', () => {
  it('escapes amounts in prose', () => {
    expect(escapeCurrencyDollars('Budget about $300, croissants $3.50.')).toBe(
      'Budget about \\$300, croissants \\$3.50.',
    );
  });

  it('leaves code spans, fenced code, math, and existing escapes alone', () => {
    const source = 'Run `echo $5` then:\n\n```\ncost=$9\n```\n\nSolve $x^2$, pay \\$4, or $$10$$.';
    expect(escapeCurrencyDollars(source)).toBe(source);
  });

  it('returns text without a dollar sign untouched', () => {
    expect(escapeCurrencyDollars('No money here.')).toBe('No money here.');
  });
});

// Nothing typesets math in a chat bubble, so a model's `$\rightarrow$`
// rendered as a literal `\rightarrow` code span, and as raw text in a table.
describe('prepareChatMarkdown', () => {
  it('turns symbol-only LaTeX into the characters it stands for', () => {
    expect(prepareChatMarkdown('Draft $\\rightarrow$ review $\\to$ publish.')).toBe(
      'Draft → review → publish.',
    );
    expect(
      prepareChatMarkdown('| Step | Next |\n|---|---|\n| Draft | $\\rightarrow$ Review |'),
    ).toBe('| Step | Next |\n|---|---|\n| Draft | → Review |');
    expect(prepareChatMarkdown('Area: $5 \\times 3 \\approx 15$ m.')).toBe('Area: 5 × 3 ≈ 15 m.');
    expect(prepareChatMarkdown('Idea \\rightarrow draft.')).toBe('Idea → draft.');
  });

  it('leaves real formulas, code, and paths alone, and still escapes currency', () => {
    const untouched =
      'Solve $x^2 \\le 4$ and $\\frac{a}{b}$. Run `echo $\\to$`. Open C:\\alpha\\beta.';
    expect(prepareChatMarkdown(untouched)).toBe(untouched);
    expect(prepareChatMarkdown('Budget $300 $\\rightarrow$ $250.')).toBe('Budget \\$300 → \\$250.');
  });
});

describe('markdownToChatDoc', () => {
  it('builds no page cover from the first heading', () => {
    const doc = markdownToChatDoc(
      parseMarkdown('Intro.\n\n## 1. Immediate Relief: Staff Schedules\n\nBody'),
      { articleId: 'gezel-chat' },
    );
    expect(doc.startBlock).toBeUndefined();
  });

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

  it('respects an explicitly authored section header treatment around a list', () => {
    const doc = markdownToChatDoc(
      parseMarkdown('## Phase 1 {[sectionHeader]}\n\n- First event\n- Second event'),
    );

    expect(doc.blocks[0]).toMatchObject({ template: 'sectionHeader' });
    expect(doc.blocks[0]?.autoTemplate).toBeUndefined();
  });
});
