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
        setContent(autosave.hydrate(res.content));
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
      <output className="status" aria-live="polite">
        {autosave.phase === 'dirty' && 'unsaved changes'}
        {autosave.phase === 'saving' && 'saving…'}
        {autosave.phase === 'saved' && 'saved'}
        {autosave.phase === 'error' && (
          <>
            Save failed: {autosave.error?.message ?? 'unknown error'}{' '}
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
