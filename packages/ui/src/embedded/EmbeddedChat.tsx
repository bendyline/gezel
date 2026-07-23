import { useEffect } from 'react';
import { ProjectDetailView } from '../views/ProjectsView.js';

/**
 * Chrome-free project surface used by external hosts (currently the
 * VS Code extension's webview). Boots from a host-provided projectId
 * + optional theme tokens and renders the broader project view —
 * tabs row (Chat / Tasks / Workspace / Artifacts / Settings / …) over
 * the active tab's content. Defaults to the Chat tab so the panel
 * behaves like a chat surface on first open, with the other project
 * tabs one click away.
 *
 * `compact` flows through ProjectsView → ProjectChat → ChatReferences
 * to suppress the right-rail commands / references panel in narrow
 * panes. The other tabs render their normal layout — the chat tab is
 * the only one that needs the narrow-form-factor adjustment today.
 */
export function EmbeddedChat({
  projectId,
  theme,
  accent,
  bg,
  fg,
  fontFamily,
  compact = false,
}: {
  projectId: string;
  /** Currently informational — `ProjectChat` derives its own selection from the project's voorman + roster. Kept on the API surface so the host can suggest a default once we wire pre-selection. */
  gezelId: string;
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

  // ProjectDetailView is the same component the desktop app's Project
  // tab renders. It owns its own project-load effect (via the inner
  // ProjectsView's `forceProjectId`-driven `openProject`), so we
  // don't pre-fetch here — that would double-load on every mount.
  return (
    <div className="embedded-chat-root">
      <ProjectDetailView projectId={projectId} compact={compact} />
    </div>
  );
}
