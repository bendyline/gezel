/**
 * Display label for a document in a list or tree.
 *
 * Markdown is the default document format in gezel, so `.md` is noise in a
 * documents list — every row would carry it. Any other extension stays
 * visible, because there it actually tells the user something (`report.csv`
 * is not `report.pdf`). Folders and extensionless names pass through.
 */
const HIDDEN_EXTENSION = /\.(md|markdown)$/i;

export function documentLabel(name: string): string {
  const base = name.replace(HIDDEN_EXTENSION, '');
  return base.length > 0 ? base : name;
}
