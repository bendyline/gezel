import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SearchMarkdownSnippet } from './SearchMarkdownSnippet.js';

describe('SearchMarkdownSnippet', () => {
  it('renders Markdown formatting without exposing its source markers', () => {
    const { container } = render(
      <button type="button">
        <SearchMarkdownSnippet
          markdown="### Minecraft **Platform** with *creator tools*, `Bedrock`, and [docs](https://example.com)."
          query="platform bedrock"
        />
      </button>,
    );

    expect(container).toHaveTextContent(
      'Minecraft Platform with creator tools, Bedrock, and docs.',
    );
    expect(container).not.toHaveTextContent('###');
    expect(container).not.toHaveTextContent('**');
    expect(screen.getByText('Platform', { selector: 'mark' }).closest('strong')).not.toBeNull();
    expect(screen.getByText('Bedrock', { selector: 'mark' }).closest('code')).not.toBeNull();
    expect(screen.getByText('creator tools', { selector: 'em' })).toBeInTheDocument();
    expect(screen.getByText('docs').closest('.search-markdown-link')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('flattens block Markdown and does not interpret raw HTML', () => {
    const { container } = render(
      <SearchMarkdownSnippet
        markdown={
          '## Experience\n\n- Built search\n- Shipped safely\n\n<script>alert("no")</script>'
        }
        query="search"
      />,
    );

    expect(container).toHaveTextContent('Experience · • Built search; • Shipped safely');
    expect(container.querySelector('script')).toBeNull();
    expect(container).not.toHaveTextContent('alert');
    expect(screen.getByText('search', { selector: 'mark' })).toBeInTheDocument();
  });

  it('leaves Markdown-like punctuation literal in source-code excerpts', () => {
    const { container } = render(
      <SearchMarkdownSnippet
        markdown="const product = 2 ** 4"
        query="product"
        formatMarkdown={false}
      />,
    );

    expect(container).toHaveTextContent('const product = 2 ** 4');
    expect(container.querySelector('strong')).toBeNull();
    expect(screen.getByText('product', { selector: 'mark' })).toBeInTheDocument();
  });
});
