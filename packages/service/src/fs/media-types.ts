/** Supported image MIME types for chat attachments and artifact previews. */
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function extForMimeType(mime: string): string {
  const key = mime.toLowerCase().split(';')[0]!.trim();
  return IMAGE_MIME_TO_EXT[key] ?? '.bin';
}

export function mimeTypeForFilename(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return IMAGE_EXT_TO_MIME[lower.slice(dot)] ?? 'application/octet-stream';
}

/** Reject any path components: filename-only values are safe to join. */
export function safeBasename(name: string): string | null {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  if (name === '.' || name === '..') return null;
  return name;
}
