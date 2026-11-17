/**
 * Exports and converted HTML inline every picture as a base64 data URI. A
 * model cannot read them, and they push a document past the inline limit, so
 * each is replaced by a short marker.
 */
export function stripDataImages(markdown: string): string {
  return markdown.replace(
    /<?data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*>?/gi,
    '#image-omitted',
  );
}
