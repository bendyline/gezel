import { deriveTemplateInputs, markdownToDoc } from '@bendyline/squisq/doc';

type ChatDoc = ReturnType<typeof markdownToDoc>;
type ChatBlock = ChatDoc['blocks'][number];

/**
 * Squisq deliberately gives automatic templates a strong visual opinion. In
 * chat, preserve that richness while resolving an ambiguous signal in favour
 * of the authored structure: a list containing a short year/stat fragment is
 * still a list, not one giant statistic with the rows flattened beneath it.
 *
 * Explicit `{[statHighlight]}` annotations are untouched. This only corrects
 * Squisq's ephemeral auto-selection on a block whose whole body is a list.
 */
function preferStructuredListTemplates(blocks: ChatBlock[]): void {
  for (const block of blocks) {
    const soleBodyNode = block.contents?.length === 1 ? block.contents[0] : undefined;
    if (block.autoTemplate && block.template === 'statHighlight' && soleBodyNode?.type === 'list') {
      const listInputs = deriveTemplateInputs('list', block.title ?? '', block.contents, {
        preserveSourceHeading: true,
      });
      if (listInputs) {
        block.template = 'list';
        block.templateData = listInputs;
      }
    }

    if (block.children) preferStructuredListTemplates(block.children);
  }
}

/** Convert parsed Markdown into the opinionated-but-readable chat rendition. */
export function markdownToChatDoc(
  markdown: Parameters<typeof markdownToDoc>[0],
  options?: Parameters<typeof markdownToDoc>[1],
): ChatDoc {
  const doc = markdownToDoc(markdown, options);
  preferStructuredListTemplates(doc.blocks);
  return doc;
}
