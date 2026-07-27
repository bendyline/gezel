import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AiToolbarButtons } from '../components/AiToolbarButtons.js';
import { ExportToolbarControls } from '../components/DocumentExport/index.js';
import { PromoteToTabButton } from '../components/PromoteToTabButton.js';
import {
  createDocumentLinkProvider,
  createDocumentsContentContainer,
  deriveContainerScope,
} from '../components/SquisqIntegration/index.js';
import { normalizeMarkdownBaseline } from '../components/markdown-baseline.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { useEffectiveTheme } from '../theme.js';

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

interface DocumentDetailProps {
  path: string;
  /**
   * True when this view is itself the active top-level tab. Suppresses
   * the "promote to tab" affordance — re-promoting would just activate
   * the tab the user is already on.
   */
  standalone?: boolean;
}

/**
 * Single-document editor surface.
 *
 * Wraps squisq's `EditorShell` with the full feature set available to
 * documents-library files: WYSIWYG + raw markdown + the Play (preview)
 * tab, the Files panel for image uploads, version history, the
 * sibling-document link picker, and a docblocks-style Export "…" menu
 * for PDF / DOCX / PPTX / HTML / Markdown / video output.
 *
 * The editor talks to disk through a `ContentContainer` adapter scoped
 * to the document's parent directory. So a doc at `notes/diary.md` can
 * embed `![](hero.jpg)` which resolves to `notes/hero.jpg` server-side.
 * Versions ride along under the same directory's `.versions/` sidecar.
 */
export function DocumentDetail({ path, standalone = false }: DocumentDetailProps) {
  const editorTheme = useEffectiveTheme();
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const saveDocument = useCallback((source: string) => api.writeDocument(path, source), [path]);
  const autosave = useSerializedAutosave({
    resourceKey: `document:${path}`,
    initialValue: content ?? '',
    save: saveDocument,
  });

  // Container + link provider are stable for the life of one open doc;
  // remounting on `path` change is the parent's responsibility (see
  // `DocumentsView`'s `key={selectedPath}` + `TabContent`'s per-tab key).
  const { root, primaryDocumentFilename } = useMemo(() => deriveContainerScope(path), [path]);
  const container = useMemo(
    () => createDocumentsContentContainer({ root, client: api, primaryDocumentFilename }),
    [root, primaryDocumentFilename],
  );
  const documentLinkProvider = useMemo(
    () => createDocumentLinkProvider({ client: api, currentDocumentPath: path }),
    [path],
  );

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setLoadError(null);
    void (async () => {
      try {
        const res = await api.readDocument(path);
        if (cancelled) return;
        // Markdown goes through the Squisq editor, which re-emits its own
        // canonical serialization at mount — baseline on that form so mere
        // open never reads as an edit (or rewrites the file). Non-markdown
        // stays verbatim.
        const baseline = isMarkdown(path) ? normalizeMarkdownBaseline(res.content) : res.content;
        setContent(autosave.hydrate(baseline));
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, autosave.hydrate]);

  const handleChange = useCallback(
    (source: string) => {
      autosave.update(source);
    },
    [autosave.update],
  );

  if (loadError) {
    return (
      <div className="placeholder">
        <p>
          Couldn't open <code>{path}</code>: {loadError}
        </p>
      </div>
    );
  }
  if (content === null) {
    return <p className="placeholder">Loading {path}…</p>;
  }

  const markdown = isMarkdown(path);

  return (
    <section className="document-detail" data-testid="document-detail">
      <div className="document-detail-head">
        <span className="document-detail-path" title={path}>
          {path}
        </span>
        <output className={`autosave-chip autosave-chip-${autosave.phase}`} aria-live="polite">
          {autosave.phase === 'dirty' && 'Unsaved changes'}
          {autosave.phase === 'saving' && 'Saving…'}
          {autosave.phase === 'saved' && 'Saved'}
          {autosave.phase === 'error' && (
            <>
              <span title={autosave.error?.message ?? 'unknown error'}>Save failed</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => void autosave.retry().catch(() => {})}
              >
                Retry
              </button>
            </>
          )}
        </output>
      </div>
      <div className="editor-wrap">
        <EditorShell
          initialMarkdown={content}
          fileName={path}
          onChange={handleChange}
          height="100%"
          colorScheme={editorTheme}
          fullWidth
          workspaceContainer={markdown ? container : null}
          documentLinkProvider={markdown ? documentLinkProvider : null}
          allowVersioning={markdown}
          versionBasename={primaryDocumentFilename}
          outline={markdown}
          toolbarSlotAfterActions={
            markdown || !standalone ? (
              <>
                {markdown && <AiToolbarButtons context="generic" />}
                {!standalone && <PromoteToTabButton target={{ kind: 'document', path }} />}
              </>
            ) : undefined
          }
          toolbarSlotRight={
            markdown ? (
              <ExportToolbarControls selectedFile={path} mediaContainer={container} />
            ) : undefined
          }
        />
      </div>
    </section>
  );
}
