import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './chat-bubbles.js';

vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

describe('MessageBubble indexed context disclosure', () => {
  it('shows approximate token counts and expands each injected excerpt', async () => {
    const user = userEvent.setup();
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="How does retrieval work?"
        authorLabel="You"
        authorIcon={null}
        projectId="gezel"
        debugMode
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
    expect(retrieval).toHaveTextContent('Used 1 source from your files · ~256 tokens injected');
    expect(source).toHaveTextContent('[workspace] src/retrieval.ts:42');
    expect(source).toHaveTextContent('~7 tokens from source');
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

  // "Consulted 1 indexed source · ~349 tokens injected" sat under an owner's
  // own message: prompt plumbing in their words' place.
  it('keeps token counts out of the summary outside debug mode', () => {
    const { container } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="user"
        content="What did we charge Maya?"
        authorLabel="You"
        authorIcon={null}
        retrieval={{
          injectedBytes: 1_396,
          hits: [{ source: 'workspace', path: 'quotes/maya.md', line: 1, score: 300 }],
        }}
      />,
    );
    expect(container.querySelector('.msg-retrieval-summary')).toHaveTextContent(
      /^Used 1 source from your files$/,
    );
  });

  it('keeps older citation-only turns usable without inventing counts or excerpts', () => {
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
      'Used 1 source from your files',
    );
    expect(container.querySelector('.msg-retrieval')).not.toHaveTextContent('tokens injected');
    expect(container.querySelector('.msg-retrieval-source')).toBeNull();
    expect(container.querySelector('.msg-ref-chip')).toHaveTextContent('[workspace] old.ts:3');
  });
});
