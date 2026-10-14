import { APP_SUBJECT_KINDS, type AppSubjectKind, type SessionSubject } from '@bendyline/gezel';

/**
 * The document an embedding host's chat is about, carried in the frame URL
 * (`?embedded=chat&focus=document&…`). The Office pane writes it with
 * {@link documentFocusParams}; the embedded SPA reads it back with
 * {@link readDocumentFocus} and opens one conversation about that document
 * instead of the whole project. Both sides go through this module so the two
 * ends of the URL cannot drift apart.
 */
export const DOCUMENT_FOCUS_PARAM = 'focus';
const DOCUMENT_FOCUS_VALUE = 'document';

export interface DocumentFocus {
  /** The stamp new threads carry: `ChatSession.subject`. */
  subject: SessionSubject;
  /**
   * Every key this document's threads may carry. A saved document's threads
   * are on its path, but the ones begun before it was saved in this pane are
   * still on the pane's surface until their next message moves them.
   */
  keys: readonly string[];
}

export function documentFocusParams(subject: SessionSubject): Record<string, string> {
  return {
    [DOCUMENT_FOCUS_PARAM]: DOCUMENT_FOCUS_VALUE,
    subjectKey: subject.key,
    subjectKind: subject.kind,
    subjectApp: subject.app,
    subjectTitle: subject.title,
  };
}

function isSubjectKind(value: string | null): value is AppSubjectKind {
  return (APP_SUBJECT_KINDS as readonly string[]).includes(value ?? '');
}

/** The frame's document, or null for an ordinary project chat. */
export function readDocumentFocus(
  params: URLSearchParams,
  surfaceId: string | null,
): DocumentFocus | null {
  if (params.get(DOCUMENT_FOCUS_PARAM) !== DOCUMENT_FOCUS_VALUE) return null;
  const key = params.get('subjectKey')?.trim();
  const kind = params.get('subjectKind');
  const app = params.get('subjectApp')?.trim();
  const title = params.get('subjectTitle')?.trim();
  if (!key || !app || !title || !isSubjectKind(kind)) return null;
  const surfaceKey = surfaceId ? `surface:${surfaceId}` : null;
  return {
    subject: { key, kind, app: app.slice(0, 40), title: title.slice(0, 200) },
    keys: surfaceKey && surfaceKey !== key ? [key, surfaceKey] : [key],
  };
}
