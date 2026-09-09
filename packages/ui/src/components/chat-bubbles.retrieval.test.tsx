import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('MessageBubble indexed context disclosure', () => {
  it('shows the exact RAG byte count and expands each injected excerpt', async () => {
    const user = userEvent.setup();
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="How does retrieval work?"
        authorLabel="You"
        authorIcon={null}
        projectId="gezel"
        retrieval={{
          injectedBytes: 1_024,
          hits: [
            {
              source: 'workspace',
              path: 'src/retrieval.ts',
              line: 42,
              score: 321,
              injectedText: 'const greeting = "gezellig";',
              injectedBytes: 28,
            },
          ],
        }}
      />,
    );

    const retrieval = container.querySelector<HTMLDetailsElement>('.msg-retrieval');
    const source = container.querySelector<HTMLDetailsElement>('.msg-retrieval-source');
    expect(retrieval).toHaveTextContent('Consulted 1 indexed source · 1,024 bytes injected');
    expect(source).toHaveTextContent('[workspace] src/retrieval.ts:42');
    expect(source).toHaveTextContent('28 bytes from source');
    expect(retrieval).toHaveTextContent('Turn total includes source labels and safety framing');
    expect(retrieval?.open).toBe(false);
    expect(source?.open).toBe(false);

    await user.click(container.querySelector<HTMLElement>('.msg-retrieval-summary')!);
    await user.click(container.querySelector<HTMLElement>('.msg-retrieval-source-summary')!);

    expect(retrieval?.open).toBe(true);
    expect(source?.open).toBe(true);
    expect(container.querySelector('.msg-retrieval-excerpt')).toHaveTextContent(
      'const greeting = "gezellig";',
    );
    expect(container.querySelector('.msg-retrieval-open')).toHaveTextContent('Open source');
  });

  it('keeps older citation-only turns usable without inventing bytes or excerpts', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="An older question"
        authorLabel="You"
        authorIcon={null}
        retrieval={{
          hits: [{ source: 'workspace', path: 'old.ts', line: 3, score: 200 }],
        }}
      />,
    );

    expect(container.querySelector('.msg-retrieval')).toHaveTextContent(
      'Consulted 1 indexed source',
    );
    expect(container.querySelector('.msg-retrieval')).not.toHaveTextContent('bytes injected');
    expect(container.querySelector('.msg-retrieval-source')).toBeNull();
    expect(container.querySelector('.msg-ref-chip')).toHaveTextContent('[workspace] old.ts:3');
  });
});
