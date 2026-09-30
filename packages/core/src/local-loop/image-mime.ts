/**
 * The mime type of a bare base64 image, from its leading bytes.
 *
 * Image payloads that arrive as plain base64 (Ollama's `images` array, a
 * remote transcript's `images`) carry no type, but llama-server only decodes
 * an `image_url` whose data URL declares `data:image/…`. The common containers
 * are recognized and anything else defaults to PNG: vision backends sniff the
 * bytes themselves, so the declared type mostly has to be *an* image type.
 */
export function sniffImageMime(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}
