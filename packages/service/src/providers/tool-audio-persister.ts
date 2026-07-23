import type { ChatSession } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * Persists audio returned by MCP tool calls — `synthesize_speech`
 * narrations, `transcribe_audio` source clips when the tool elects to
 * surface them — into the project's artifacts/ tree. Mirrors
 * `ToolImagePersister` exactly; the audio is just a different MIME
 * shape with a different chat-row widget on the UI side.
 *
 * Layout:
 *
 *   <project>/artifacts/sessions/<friendly-id>/tool-<n>-audio-<i>.<ext>
 */
export interface ToolAudioPersister {
  persist(
    audios: ReadonlyArray<{
      base64: string;
      mimeType: string;
      durationSeconds?: number;
      voice?: string;
    }>,
  ): Promise<Array<{ path: string; mimeType: string; durationSeconds?: number; voice?: string }>>;
}

export interface CreateToolAudioPersisterOptions {
  store: Store;
  projectId: string;
  session: Pick<ChatSession, 'id' | 'createdAt' | 'title'>;
}

export function createToolAudioPersister(
  opts: CreateToolAudioPersisterOptions,
): ToolAudioPersister {
  const subfolder = sessionSubfolder(opts.session);
  let toolCallIndex = 0;
  return {
    async persist(audios) {
      if (audios.length === 0) return [];
      const idx = toolCallIndex++;
      const out: Array<{
        path: string;
        mimeType: string;
        durationSeconds?: number;
        voice?: string;
      }> = [];
      for (let i = 0; i < audios.length; i++) {
        const audio = audios[i];
        if (!audio) continue;
        const ext = extensionForMime(audio.mimeType);
        const relPath = `sessions/${subfolder}/tool-${idx}-audio-${i}${ext}`;
        const buf = Buffer.from(audio.base64, 'base64');
        const written = await opts.store.writeProjectArtifactBinary(opts.projectId, relPath, buf);
        const entry: {
          path: string;
          mimeType: string;
          durationSeconds?: number;
          voice?: string;
        } = { path: written, mimeType: audio.mimeType };
        if (audio.durationSeconds !== undefined) entry.durationSeconds = audio.durationSeconds;
        if (audio.voice) entry.voice = audio.voice;
        out.push(entry);
      }
      return out;
    },
  };
}

function sessionSubfolder(session: Pick<ChatSession, 'id' | 'createdAt' | 'title'>): string {
  const ts = formatTimestampForFolder(session.createdAt);
  const slug = slugifyTitle(session.title);
  if (slug) return `${ts}_${slug}`;
  return `${ts}_${session.id.slice(0, 8)}`;
}

function formatTimestampForFolder(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown-date';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}`;
}

function slugifyTitle(title: string | undefined): string {
  if (!title) return '';
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return '';
  return slug.length > 40 ? slug.slice(0, 40).replace(/-+$/, '') : slug;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/mpeg':
      return '.mp3';
    case 'audio/mp4':
    case 'audio/aac':
      return '.m4a';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/flac':
      return '.flac';
    case 'audio/webm':
      return '.webm';
    default:
      return '.bin';
  }
}
