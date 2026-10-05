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
    expect(sources).toHaveTextContent('1 source · 1 statement not found in any source');
    expect(container.querySelector('.msg-grounding-issue')).toHaveTextContent(
      'He had a son named Samuel. — not in any source: Samuel',
    );
    expect(sources?.open).toBe(false);

    const marker = container.querySelector<HTMLAnchorElement>('a[href="#cite:3"]');
    expect(marker).toHaveTextContent('[3]');
    await user.click(marker!);

    expect(sources?.open).toBe(true);
    expect(
      container.querySelector<HTMLDetailsElement>('.msg-grounding .msg-retrieval-source')?.open,
    ).toBe(true);
    expect(container.querySelector('.msg-grounding .msg-retrieval-excerpt')).toHaveTextContent(
      'Augustine Washington died in 1743.',
    );
  });
});
