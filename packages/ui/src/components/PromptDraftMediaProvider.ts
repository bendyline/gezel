import type { MediaEntry, MediaProvider } from '@bendyline/squisq';
import { api } from '../api.js';
import { BLOCKED_REMOTE_MEDIA_URL, createGezelMediaProvider } from './GezelMediaProvider.js';
import { createDocumentMediaProvider } from './SquisqIntegration/documents-container.js';
import { createArtifactsContentContainer } from './SquisqIntegration/index.js';

/**
 * Media for a prompt draft, which is shaped exactly like every other squisq
 * document in gezel: the draft owns `message_files/` beside `message.md`, and
 * references inside the markdown are document-relative (`message_files/x.png`).
 * The send path rewrites them to their project-relative form on the way into
 * the transcript.
 *
 * Two things make this different from the plain project provider it replaces:
 *
 * - **The draft may not exist yet.** Someone can paste an image into an empty
 *   composer, and that paste is what brings the draft into being — so
 *   `addMedia` awaits `ensureDraftId()` rather than assuming an id.
 * - **The draft can change under it.** Switching threads swaps the active
 *   draft, so the provider reads its id through a getter and keeps one inner
 *   provider per draft instead of being rebuilt (which would revoke the blob
 *   URLs the editor is still displaying).
 *
 * Older messages hold `attachments/…` refs and model output holds
 * `artifacts/…` refs; both keep resolving through a lazily built fallback, so
 * a prefilled screenshot or a generated image still renders in the composer.
 */

export interface PromptDraftMediaProviderOptions {
  projectId: string;
  /** The active draft, or null before the first keystroke or paste. */
  getDraftId: () => string | null;
  /** Create the draft if it does not exist yet, and return its id. */
  ensureDraftId: () => Promise<string>;
}

function isRemoteOrUnsafeMediaUrl(value: string): boolean {
  const url = value.trim();
  if (/^(?:data|blob):/i.test(url)) return false;
  return url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url);
}

export function createPromptDraftMediaProvider(
  opts: PromptDraftMediaProviderOptions,
): MediaProvider {
  const perDraft = new Map<string, MediaProvider>();
  let fallback: MediaProvider | null = null;

  const forDraft = (draftId: string): MediaProvider => {
    let hit = perDraft.get(draftId);
    if (!hit) {
      hit = createDocumentMediaProvider(
        createArtifactsContentContainer({
          projectId: opts.projectId,
          root: `prompts/${draftId}/message_files`,
          client: api,
          referencePrefix: 'message_files',
        }),
        'message_files',
      );
      perDraft.set(draftId, hit);
    }
    return hit;
  };

  const legacy = (): MediaProvider => {
    fallback ??= createGezelMediaProvider({ projectId: opts.projectId });
    return fallback;
  };

  return {
    async addMedia(name, data, mimeType): Promise<string> {
      const draftId = await opts.ensureDraftId();
      return forDraft(draftId).addMedia(name, data, mimeType);
    },

    async resolveUrl(relPath: string): Promise<string> {
      // Model-authored network URLs are passive egress — same refusal the
      // project provider makes, applied before anything can reach an <img>.
      if (isRemoteOrUnsafeMediaUrl(relPath)) return BLOCKED_REMOTE_MEDIA_URL;
      if (/^(?:data|blob):/i.test(relPath.trim())) return relPath;
      const draftId = opts.getDraftId();
      const normalized = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
      if (draftId && normalized.startsWith('message_files/')) {
        return forDraft(draftId).resolveUrl(relPath);
      }
      return legacy().resolveUrl(relPath);
    },

    async listMedia(): Promise<MediaEntry[]> {
      const draftId = opts.getDraftId();
      // An empty composer has no files panel to fill, and asking the server
      // about a draft that does not exist would 404 on every mount.
      if (!draftId) return [];
      return forDraft(draftId).listMedia();
    },

    async removeMedia(relPath: string): Promise<void> {
      const draftId = opts.getDraftId();
      const normalized = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
      if (draftId && normalized.startsWith('message_files/')) {
        await forDraft(draftId).removeMedia(relPath);
        return;
      }
      await legacy().removeMedia(relPath);
    },

    dispose(): void {
      for (const provider of perDraft.values()) provider.dispose();
      perDraft.clear();
      fallback?.dispose();
      fallback = null;
    },
  };
}
