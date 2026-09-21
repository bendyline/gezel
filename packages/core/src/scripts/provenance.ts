const MARKER = '// @gezel-craftbook:';
/** File marker shared with the desktop installer; it is provenance, never a trust grant. */
export function craftbookScriptHeader(craftbookId: string, version: string): string {
  return `${MARKER} ${craftbookId}@${version}\n`;
}
export function craftbookScriptProvenance(content: string): string | null {
  if (!content.startsWith(MARKER)) return null;
  const newline = content.indexOf('\n');
  return (newline === -1 ? content : content.slice(0, newline)).slice(MARKER.length).trim();
}
