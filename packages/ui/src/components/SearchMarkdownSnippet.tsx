import type {
  MarkdownBlockNode,
  MarkdownInlineNode,
  MarkdownListItem,
  MarkdownTableCell,
} from '@bendyline/squisq/markdown';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { Fragment, type ReactNode, useMemo } from 'react';
import { highlightTokens } from './highlight-tokens.js';

interface SearchMarkdownSnippetProps {
  /** A short excerpt returned by the search index. */
  markdown: string;
  /** The active query; matching terms remain highlighted inside formatted runs. */
  query: string;
  /** False for source-code excerpts where Markdown punctuation is literal. */
  formatMarkdown?: boolean;
}

const MARKDOWN_NATIVE_RESULT_KINDS = new Set(['memory', 'session', 'handboek', 'knowledge']);

/** Whether an indexed excerpt is Markdown rather than literal source code. */
export function searchSnippetIsMarkdown(kind: string, pathOrTitle: string): boolean {
  return MARKDOWN_NATIVE_RESULT_KINDS.has(kind) || /\.(?:md|markdown|mdx)$/i.test(pathOrTitle);
}

/**
 * Compact Markdown for search-result excerpts.
 *
 * A result row is already an interactive control, so this deliberately renders
 * links as styled text rather than nesting anchors inside the row. Block
 * structure is flattened to a single compact run while inline meaning (strong,
 * emphasis, code, strike-through) survives. Raw HTML tags are ignored.
 */
export function SearchMarkdownSnippet({
  markdown,
  query,
  formatMarkdown = true,
}: SearchMarkdownSnippetProps) {
  const blocks = useMemo(() => {
    if (!formatMarkdown) return null;
    try {
      return parseMarkdown(markdown, { parseHtml: false }).children;
    } catch {
      return null;
    }
  }, [formatMarkdown, markdown]);

  if (!blocks) return <>{highlightTokens(markdown, query)}</>;
  return <>{renderBlocks(blocks, query)}</>;
}

function separated(parts: ReactNode[], separator = ' · '): ReactNode[] {
  return parts.flatMap((part, index) => (index === 0 ? [part] : [separator, part]));
}

function renderBlocks(nodes: readonly MarkdownBlockNode[], query: string): ReactNode[] {
  return separated(
    nodes.flatMap((node, index): ReactNode[] => {
      const key = `${node.type}-${index}`;
      switch (node.type) {
        case 'heading':
          return [
            <strong className="search-markdown-heading" key={key}>
              {renderInline(node.children, query)}
            </strong>,
          ];
        case 'paragraph':
          return [<Fragment key={key}>{renderInline(node.children, query)}</Fragment>];
        case 'blockquote':
          return [
            <span className="search-markdown-quote" key={key}>
              {renderBlocks(node.children, query)}
            </span>,
          ];
        case 'list':
          return [
            <Fragment key={key}>
              {separated(
                node.children.map((item, itemIndex) =>
                  renderListItem(
                    item,
                    query,
                    node.ordered ? (node.start ?? 1) + itemIndex : null,
                    `${key}-${itemIndex}`,
                  ),
                ),
                '; ',
              )}
            </Fragment>,
          ];
        case 'code':
          return [<code key={key}>{highlightTokens(node.value, query)}</code>];
        case 'table':
          return [
            <Fragment key={key}>
              {separated(
                node.children.flatMap((row, rowIndex) =>
                  row.children.map((cell, cellIndex) =>
                    renderTableCell(cell, query, `${key}-${rowIndex}-${cellIndex}`),
                  ),
                ),
                ' · ',
              )}
            </Fragment>,
          ];
        case 'math':
          return [
            <span className="search-markdown-math" key={key}>
              {highlightTokens(node.value, query)}
            </span>,
          ];
        case 'footnoteDefinition':
        case 'containerDirective':
          return [<Fragment key={key}>{renderBlocks(node.children, query)}</Fragment>];
        case 'leafDirective':
          return [<Fragment key={key}>{renderInline(node.children, query)}</Fragment>];
        // Link definitions, thematic rules, and raw HTML carry no useful
        // reader-facing excerpt on their own.
        case 'definition':
        case 'thematicBreak':
        case 'htmlBlock':
          return [];
        case 'definitionList':
          return [
            <Fragment key={key}>
              {separated(
                node.children.map((child, childIndex): ReactNode => {
                  const childKey = `${key}-${childIndex}`;
                  return child.type === 'definitionTerm' ? (
                    <Fragment key={childKey}>{renderInline(child.children, query)}</Fragment>
                  ) : (
                    <Fragment key={childKey}>{renderBlocks(child.children, query)}</Fragment>
                  );
                }),
                ' · ',
              )}
            </Fragment>,
          ];
      }
    }),
  );
}

function renderListItem(
  item: MarkdownListItem,
  query: string,
  number: number | null,
  parentKey: string,
): ReactNode {
  const marker =
    item.checked != null ? (item.checked ? '✓ ' : '○ ') : number == null ? '• ' : `${number}. `;
  return (
    <span className="search-markdown-list-item" key={`${parentKey}-item`}>
      <span aria-hidden="true">{marker}</span>
      {renderBlocks(item.children, query)}
    </span>
  );
}

function renderTableCell(cell: MarkdownTableCell, query: string, key: string): ReactNode {
  const content = renderInline(cell.children, query);
  return cell.isHeader ? (
    <strong key={key}>{content}</strong>
  ) : (
    <Fragment key={key}>{content}</Fragment>
  );
}

function renderInline(nodes: readonly MarkdownInlineNode[], query: string): ReactNode[] {
  return nodes.flatMap((node, index): ReactNode[] => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case 'text':
        return [<Fragment key={key}>{highlightTokens(node.value, query)}</Fragment>];
      case 'strong':
        return [<strong key={key}>{renderInline(node.children, query)}</strong>];
      case 'emphasis':
        return [<em key={key}>{renderInline(node.children, query)}</em>];
      case 'delete':
        return [<del key={key}>{renderInline(node.children, query)}</del>];
      case 'superscript':
        return [<sup key={key}>{renderInline(node.children, query)}</sup>];
      case 'subscript':
        return [<sub key={key}>{renderInline(node.children, query)}</sub>];
      case 'inlineCode':
        return [<code key={key}>{highlightTokens(node.value, query)}</code>];
      case 'link':
      case 'linkReference':
        return [
          <span className="search-markdown-link" key={key}>
            {renderInline(node.children, query)}
          </span>,
        ];
      case 'image':
      case 'imageReference':
        return node.alt
          ? [
              <span className="search-markdown-image" key={key}>
                {highlightTokens(node.alt, query)}
              </span>,
            ]
          : [];
      case 'break':
        return [' '];
      case 'inlineMath':
        return [
          <span className="search-markdown-math" key={key}>
            {highlightTokens(node.value, query)}
          </span>,
        ];
      case 'footnoteReference':
        return [<sup key={key}>{highlightTokens(node.label ?? node.identifier, query)}</sup>];
      case 'textDirective':
        return [<Fragment key={key}>{renderInline(node.children, query)}</Fragment>];
      case 'mention':
        return [
          <span className="search-markdown-mention" key={key}>
            @{highlightTokens(node.displayName, query)}
          </span>,
        ];
      case 'inlineIcon':
        return [<Fragment key={key}>{highlightTokens(node.name, query)}</Fragment>];
      // HTML markup is never interpreted in a search control. Text between
      // paired inline tags arrives as ordinary `text` siblings and survives.
      case 'htmlInline':
        return [];
    }
  });
}
