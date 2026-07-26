import { LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { gezelChatTheme } from './chat-theme.js';

/**
 * Real (unmocked) squisq-react rendering under this repo's React.
 *
 * Guards the react/react-dom `resolve.dedupe` in vite.config.ts +
 * vitest.config.ts: with `pnpm link:squisq` active, the sibling
 * checkout's workspace carries react 18 for its own tooling, and
 * without dedupe its bare `import "react"` resolves there — a second
 * React whose 18-shaped context objects react-dom 19 refuses to render
 * (minified React error #130, the broken-Handboek-tab incident). Every
 * squisq surface (chat bubbles, Handboek, document editor) breaks the
 * same way, so this failing means "fix module resolution", not "fix
 * the component under test".
 */
describe('squisq-react under the app react', () => {
  it('MediaContext was created by the same React that renders it', () => {
    const { container } = render(
      <MediaContext.Provider value={null}>
        <div data-testid="inner" />
      </MediaContext.Provider>,
    );
    expect(container.querySelector('[data-testid="inner"]')).toBeTruthy();
  });

  it('LinearDocView renders a markdown doc', () => {
    const doc = markdownToDoc(parseMarkdown('# Hello\n\nWorld.'), { articleId: 'probe' });
    const { container } = render(<LinearDocView doc={doc} theme={gezelChatTheme} />);
    expect(container.textContent).toContain('Hello');
  });
});
