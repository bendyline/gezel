import type { MediaEntry, MediaProvider } from '@bendyline/squisq';
import type { ContentContainer } from '@bendyline/squisq/storage';

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function mimeForPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const dot = clean.lastIndexOf('.');
  return dot < 0
    ? 'application/octet-stream'
    : (MIME_BY_EXTENSION[clean.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream');
}

function isExternalUrl(path: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(path);
}

/**
 * Adapt the document editor's Squisq ContentContainer to the MediaProvider
 * consumed by Squisq's video/GIF renderer. Blob URLs are scoped to one mounted
 * export control and revoked on disposal.
 */
export function createContainerMediaProvider(container: ContentContainer): MediaProvider {
  const objectUrls = new Map<string, string>();

  return {
    async resolveUrl(relativePath: string): Promise<string> {
      if (isExternalUrl(relativePath)) return relativePath;
      const cached = objectUrls.get(relativePath);
      if (cached) return cached;

      const data = await container.readFile(relativePath);
      if (!data) return relativePath;
      const url = URL.createObjectURL(new Blob([data], { type: mimeForPath(relativePath) }));
      objectUrls.set(relativePath, url);
      return url;
    },

    async listMedia(): Promise<MediaEntry[]> {
      const entries = await container.listFiles();
      return entries
        .filter((entry) => /^(?:image|audio|video)\//.test(entry.mimeType))
        .map((entry) => ({
          name: entry.path,
          mimeType: entry.mimeType,
          size: entry.size,
        }));
    },

    async addMedia(name, data, mimeType): Promise<string> {
      const bytes =
        data instanceof Blob
          ? await data.arrayBuffer()
          : data instanceof Uint8Array
            ? data
            : new Uint8Array(data);
      await container.writeFile(name, bytes, mimeType);
      return name;
    },

    async removeMedia(relativePath: string): Promise<void> {
      await container.removeFile(relativePath);
      const url = objectUrls.get(relativePath);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.delete(relativePath);
      }
    },

    dispose(): void {
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
      objectUrls.clear();
    },
  };
}
