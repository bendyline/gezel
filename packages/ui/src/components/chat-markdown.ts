import { deriveTemplateInputs, markdownToDoc } from '@bendyline/squisq/doc';

type ChatDoc = ReturnType<typeof markdownToDoc>;
type ChatBlock = ChatDoc['blocks'][number];

/**
 * Squisq deliberately gives automatic templates a strong visual opinion. In
 * chat, preserve that richness while resolving an ambiguous signal in favour
 * of the authored structure: a list containing a short year/stat fragment is
 * still a list, not one giant statistic or an implicit section header with
 * the rows flattened beneath it.
 *
 * Explicit template annotations are untouched. This only corrects Squisq's
 * ephemeral auto-selection (or its unmarked default section-header fallback)
 * on a block whose whole body is a list.
 */
function preferStructuredListTemplates(blocks: ChatBlock[]): void {
  for (const block of blocks) {
    const soleBodyNode = block.contents?.length === 1 ? block.contents[0] : undefined;
    const hasAuthoredTemplate = Boolean(
      block.sourceHeading?.templateAnnotation?.template || block.promotedBodyAnnotation,
    );
    const isImplicitListFlatteningTemplate =
      (block.autoTemplate === true && block.template === 'statHighlight') ||
      (block.template === 'sectionHeader' && !hasAuthoredTemplate);

    if (isImplicitListFlatteningTemplate && soleBodyNode?.type === 'list') {
      const listInputs = deriveTemplateInputs('list', block.title ?? '', block.contents, {
        preserveSourceHeading: true,
      });
      if (listInputs) {
        block.template = 'list';
        block.autoTemplate = true;
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
