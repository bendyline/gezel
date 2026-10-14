import { useEffect, useState } from 'react';
import { ProjectDetailView } from '../views/ProjectsView.js';
import '../surfaces.css';
import { DocumentChat } from './DocumentChat.js';
import type { DocumentFocus } from './document-focus.js';

/**
 * Chrome-free project surface used by external hosts (the VS Code
 * extension's webview, the Office task pane). Boots from a host-provided
 * projectId + optional theme tokens and renders the broader project view —
 * tabs row (Chat / Tasks / Workspace / Artifacts / Settings / …) over
 * the active tab's content. Defaults to the Chat tab so the panel
 * behaves like a chat surface on first open, with the other project
 * tabs one click away. A host that names a document (`documentFocus`)
 * gets {@link DocumentChat} first instead, with the project behind a key.
 *
 * `compact` flows through ProjectsView → ProjectChat → ChatReferences
 * to suppress the right-rail commands / references panel in narrow
 * panes. The other tabs render their normal layout — the chat tab is
 * the only one that needs the narrow-form-factor adjustment today.
 */
export function EmbeddedChat({
  projectId,
  gezelId,
  theme,
  accent,
  bg,
  fg,
  fontFamily,
  compact = false,
  documentFocus = null,
}: {
  projectId: string;
  /**
   * The gezel the host talks to. The project view seeds its recipient from
   * it (App.tsx); the document view talks to this gezel only.
   */
  gezelId: string;
  /**
   * The document the host's chat is about (the Office pane's). Opens one
   * conversation about it instead of the project, with the project a key
   * away. Null for an ordinary embedded project chat (VS Code).
   */
  documentFocus?: DocumentFocus | null;
  theme: string | null;
  accent: string | null;
  bg: string | null;
  fg: string | null;
  fontFamily: string | null;
  /**
   * Narrow form factor (VS Code chat sidebar, mobile). Forwarded to
   * `ProjectsView` so the chat tab's right-rail commands / references
   * panel is suppressed — there's not enough horizontal room for both.
   */
  compact?: boolean;
}) {
  useEffect(() => {
    const root = document.documentElement;
    if (accent) root.style.setProperty('--accent', accent);
    if (bg) root.style.setProperty('--bg', bg);
    if (fg) root.style.setProperty('--fg', fg);
    if (fontFamily) root.style.setProperty('--font-ui', fontFamily);
    if (theme) root.setAttribute('data-host-theme', theme);
    root.classList.add('embedded-chat');
    return () => {
      root.classList.remove('embedded-chat');
      root.removeAttribute('data-host-theme');
    };
  }, [theme, accent, bg, fg, fontFamily]);

  const [showProject, setShowProject] = useState(false);

  if (documentFocus && !showProject) {
    return (
      <div className="embedded-chat-root">
        <DocumentChat
          projectId={projectId}
          gezelId={gezelId}
          subject={documentFocus.subject}
          subjectKeys={documentFocus.keys}
          onShowProject={() => setShowProject(true)}
        />
      </div>
    );
  }

  // ProjectDetailView is the same component the desktop app's Project
  // tab renders. It owns its own project-load effect (via the inner
  // ProjectsView's `forceProjectId`-driven `openProject`), so we
  // don't pre-fetch here — that would double-load on every mount.
  return (
    <div className="embedded-chat-root">
      {documentFocus && (
        <div className="document-chat-return">
          <button
            type="button"
            className="secondary document-chat-back"
            onClick={() => setShowProject(false)}
          >
            Back to {documentFocus.subject.title}
          </button>
        </div>
      )}
      <ProjectDetailView projectId={projectId} compact={compact} />
    </div>
  );
}
