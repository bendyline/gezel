import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AutosaveStatus } from '../components/AutosaveStatus.js';
import { ExportToolbarControls } from '../components/DocumentExport/index.js';
import {
  createDocumentLinkProvider,
  createDocumentsContentContainer,
  deriveContainerScope,
  resolveOutsideInLayout,
} from '../components/SquisqIntegration/index.js';
import { BINARY_FILE, NonTextFilePreview, looksBinary } from '../components/file-browser/index.js';
import { normalizeMarkdownBaseline } from '../components/markdown-baseline.js';
import { TransformToolbarButton } from '../components/transform/TransformToolbarButton.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { useEffectiveTheme } from '../theme.js';
import { OutsideInDocumentDetail } from './OutsideInDocumentDetail.js';

function isMarkdown(name: string): boolean {
  const basename = name.slice(name.lastIndexOf('/') + 1);
  // The Documents UI allows friendly names without requiring an extension.
  // Those entries still open in the Markdown editor and should receive the
  // same editor features as an explicit .md file.
  return !basename.includes('.') || /\.(md|markdown|mdx)$/i.test(basename);
}

interface DocumentDetailProps {
  path: string;
}

/**
 * Single-document editor surface.
 *
 * Wraps squisq's `EditorShell` with the full feature set available to
 * documents-library files: WYSIWYG + raw markdown + the Play (preview)
 * tab, the Files panel for image uploads, version history, the
 * sibling-document link picker, and a DocBlocks-style Export menu
 * for PDF / DOCX / PPTX / HTML / Markdown / video output.
 *
 * The editor talks to disk through a `ContentContainer` adapter scoped
 * to the document's parent directory. So a doc at `notes/diary.md` can
 * embed `![](hero.jpg)` which resolves to `notes/hero.jpg` server-side.
 * Versions ride along under the same directory's `.versions/` sidecar.
 */
export function DocumentDetail({ path }: DocumentDetailProps) {
  const outsideInLayout = useMemo(() => resolveOutsideInLayout(path), [path]);
  if (outsideInLayout) {
    return <OutsideInDocumentDetail path={path} layout={outsideInLayout} />;
  }
  return <TextDocumentDetail path={path} />;
}

const fetchDocumentBlob = (filePath: string) => api.fetchDocumentBlob(filePath);

function TextDocumentDetail({ path }: DocumentDetailProps) {
  const editorTheme = useEffectiveTheme();
  const [content, setContent] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | undefined>(undefined);
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
    setSizeBytes(undefined);
    setLoadError(null);
    void (async () => {
      try {
        const res = await api.readDocument(path);
        if (cancelled) return;
        setSizeBytes(res.size);
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
  // Backstop for binary types the extension didn't reveal — the same one the
  // project file panels use. Raw bytes in the editor render as garbage and an
  // autosave would write that garbage back.
  if (looksBinary(content)) {
    return (
      <NonTextFilePreview
        content={BINARY_FILE}
        path={path}
        fetchBlob={fetchDocumentBlob}
        {...(sizeBytes === undefined ? {} : { sizeBytes })}
      />
    );
  }

  const markdown = isMarkdown(path);

  return (
    <section className="document-detail" data-testid="document-detail">
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
          toolbarSlotAfterActions={
            markdown ? <TransformToolbarButton context="generic" /> : undefined
          }
          toolbarSlotRight={
            markdown ? (
              <ExportToolbarControls
                selectedFile={path}
                mediaContainer={container}
                mediaSource={{ kind: 'documents' }}
              />
            ) : undefined
          }
          statusBarSlotRight={<AutosaveStatus autosave={autosave} />}
        />
      </div>
    </section>
  );
}
