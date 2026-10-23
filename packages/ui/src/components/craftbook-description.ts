/**
 * Display-only wording for craftbook previews and tool requirements. Runtime placeholders
 * stay intact in the craftbook; setup screens show authored parameter titles
 * or readable fallbacks instead of template syntax. Related: CraftbookToolsetSetup.
 */
const LABELS: Record<string, string> = {
  sourceOutputPath: 'the source document',
  source: 'the source document',
  outputPath: 'the output file',
  workPath: 'the working folder',
  'task.dir': 'the task folder',
};

export function craftbookDescription(
  reason: string,
  paramSchema?: Record<string, unknown>,
): string {
  const properties = paramSchema?.properties as Record<string, { title?: unknown }> | undefined;
  return reason.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    // Generated output locations describe a document or folder, not a form field.
    if (key !== 'source' && LABELS[key]) return LABELS[key];
    const title = properties?.[key]?.title;
    return typeof title === 'string' && title.trim()
      ? title.trim()
      : (LABELS[key] ??
          key
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_.-]+/g, ' ')
            .toLowerCase());
  });
}
