/** MIME types preserved for chat attachments and artifact previews. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.ms-excel': '.xls',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
};

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  // Without these two, a .bmp/.ico goes out as application/octet-stream —
  // which the llama.cpp vision server rejects at the data-URI parse with a
  // 500 before ever looking at the bytes.
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
};

export function extForMimeType(mime: string): string {
  const key = mime.toLowerCase().split(';')[0]!.trim();
  return MIME_TO_EXT[key] ?? '.bin';
}

export function mimeTypeForFilename(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return EXT_TO_MIME[lower.slice(dot)] ?? 'application/octet-stream';
}

/** Reject any path components: filename-only values are safe to join. */
export function safeBasename(name: string): string | null {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  if (name === '.' || name === '..') return null;
  return name;
}
