import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const grounding = {
  evidence: [
    {
      n: 3,
      kind: 'tool' as const,
      tool: 'read_file',
      title: 'notes/family.md',
      ref: 'notes/family.md',
      excerpt: 'Augustine Washington died in 1743.',
    },
  ],
  counts: { supported: 1, cited: 0, unattributed: 0, uncited: 1, unsupported: 0, badCitation: 0 },
  problems: [
    { text: 'He had a son named Samuel.', status: 'uncited' as const, missing: ['Samuel'] },
  ],
};

describe('MessageBubble factual-mode sources', () => {
  it('links [n] to its source and names statements no source showed', async () => {
    const user = userEvent.setup();
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="His father died in 1743 [3]. He had a son named Samuel."
        authorLabel="Writer"
        authorIcon={null}
        projectId="family"
        grounding={grounding}
      />,
    );

    const sources = container.querySelector<HTMLDetailsElement>('.msg-grounding');
    expect(sources).toHaveTextContent('1 source · 1 statement to check, marked above');
    expect(container.querySelector('.msg-grounding-issue')).toHaveTextContent(
      'He had a son named Samuel. — not in any source: Samuel',
    );
    expect(sources?.open).toBe(false);

    // The ledger's [3] is this reply's first source, so it reads [1].
    const marker = container.querySelector<HTMLAnchorElement>('a[href="#cite:3"]');
    expect(marker).toHaveTextContent('[1]');
    await user.click(marker!);

    expect(sources?.open).toBe(true);
    expect(
      container.querySelector<HTMLDetailsElement>('.msg-grounding .msg-retrieval-source')?.open,
    ).toBe(true);
    expect(container.querySelector('.msg-grounding .msg-retrieval-excerpt')).toHaveTextContent(
      'Augustine Washington died in 1743.',
    );
  });

  // A bakery's first answer cited one file as [13] under "13 sources": the
  // ledger numbers across the session and keeps everything the turn read, and
  // a doubted sentence showed its **asterisks** (2026-11-09).
  it('counts and numbers the sources this reply cites, and quotes doubts as plain text', () => {
    const read = (n: number, path: string, excerpt: string) => ({
      n,
      kind: 'retrieval' as const,
      title: path,
      ref: path,
      excerpt,
    });
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="A full refund up to 72 hours before [13]. Inside 72 hours the deposit is kept [12]. **Sunday** is busiest."
        authorLabel="Librarian"
        authorIcon={null}
        projectId="bakery"
        grounding={{
          evidence: [
            read(1, 'Menu/menu.md', 'Croissants $4.'),
            read(12, 'Catering/policy.txt', 'Inside 72 hours the deposit is kept.'),
            {
              n: 13,
              kind: 'tool',
              tool: 'read_file',
              title: 'Catering/policy.txt',
              ref: 'Catering/policy.txt',
              excerpt: 'Cancellation: full refund up to 72 hours before.',
            },
          ],
          counts: {
            supported: 2,
            cited: 2,
            unattributed: 0,
            uncited: 1,
            unsupported: 0,
            badCitation: 0,
          },
          problems: [{ text: '**Sunday** is busiest.', status: 'uncited', missing: ['Sunday'] }],
        }}
      />,
    );
    const sources = container.querySelector<HTMLDetailsElement>('.msg-grounding');
    expect(sources?.querySelector('.msg-retrieval-summary')).toHaveTextContent(/^1 source · /);
    expect(container.querySelector('a[href="#cite:13"]')).toHaveTextContent('[1]');
    expect(container.querySelector('a[href="#cite:12"]')).toHaveTextContent('[1]');
    const labels = [...container.querySelectorAll('.msg-grounding .msg-retrieval-source-label')];
    expect(labels.map((label) => label.textContent)).toEqual(['[1] Catering/policy.txt']);
    expect(container.querySelector('.msg-grounding-issue')).toHaveTextContent(
      'Sunday is busiest. — not in any source: Sunday',
    );
    expect(container.querySelector('.msg-grounding-issue')?.textContent).not.toContain('*');
  });
});

// A sum the engine calculated is shown with its working: the person sees the
// query and its result rather than taking the number on trust (2026-11-09).
describe('MessageBubble calculated sources', () => {
  it('shows how a number was calculated, and what the query returned', async () => {
    const user = userEvent.setup();
    const sql = 'SELECT product, sum(total) FROM sales_october_2026 GROUP BY 1';
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="Latte earned the most, 13,035.00 [1]."
        authorLabel="Analyst"
        authorIcon={null}
        projectId="bakery"
        grounding={{
          evidence: [
            {
              n: 1,
              kind: 'tool',
              tool: 'query_table',
              title: 'Calculated from sales_october_2026',
              query: sql,
              excerpt: '1 row(s).\n\n| product | total |\n| Latte | 13035.00 |',
            },
          ],
          counts: {
            supported: 1,
            cited: 1,
            unattributed: 0,
            uncited: 0,
            unsupported: 0,
            badCitation: 0,
          },
          problems: [],
        }}
      />,
    );
    const sources = container.querySelector<HTMLDetailsElement>('.msg-grounding');
    expect(sources).toHaveTextContent('[1] Calculated from sales_october_2026');
    expect(sources).not.toHaveTextContent('to check');
    await user.click(container.querySelector<HTMLAnchorElement>('a[href="#cite:1"]')!);
    expect(container.querySelector('.msg-grounding-query')).toHaveTextContent(sql);
    expect(sources).toHaveTextContent('How it was calculated');
    expect(sources).toHaveTextContent('What it returned');
  });
});
