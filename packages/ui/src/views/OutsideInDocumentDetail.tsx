import { EditorShell } from '@bendyline/squisq-editor-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AutosaveStatus } from '../components/AutosaveStatus.js';
import { PromoteToTabButton } from '../components/PromoteToTabButton.js';
import {
  type OutsideInLayout,
  chooseOutsideInSource,
  createDocumentLinkProvider,
  createDocumentsContentContainer,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  relativePath,
  renderOutsideInDocument,
  runtimePathForTarget,
  withOutsideInMarkdownEditing,
  withOutsideInMetadata,
} from '../components/SquisqIntegration/index.js';
import { normalizeMarkdownBaseline } from '../components/markdown-baseline.js';
import { TransformToolbarButton } from '../components/transform/TransformToolbarButton.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { useEffectiveTheme } from '../theme.js';

interface PreparedDocument {
  sourcePath: string;
  content: string;
  editingEnabled: boolean;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

async function prepareDocument(path: string, layout: OutsideInLayout): Promise<PreparedDocument> {
  const listing = await api.listDocuments('', true);
  let sourcePath = chooseOutsideInSource(
    layout,
    listing.files.filter((entry) => !entry.isDirectory).map((entry) => entry.path),
  );
  let content: string;

  if (sourcePath) {
    content = (await api.readDocument(sourcePath)).content;
  } else {
    const blob = await api.fetchDocumentBlob(path);
    const imported = await importOutsideInDocument(await blob.arrayBuffer(), layout);
    const container = createDocumentsContentContainer({
      root: layout.companionDirectory,
      client: api,
      primaryDocumentFilename: layout.markdownFilename,
    });
    for (const entry of await imported.container.listFiles()) {
      if (/\.md$/i.test(entry.path)) continue;
      // Some format importers retain the source package in their memory
      // container. The user-visible DOCX/PDF/etc. already lives one level up;
      // copying it into the companion would make it appear as an unused file
      // attachment in the editor's Files panel.
      if (
        basename(entry.path).toLocaleLowerCase('en-US') ===
        basename(path).toLocaleLowerCase('en-US')
      ) {
        continue;
      }
      const data = await imported.container.readFile(entry.path);
      if (!data) continue;
      await container.writeFile(entry.path, data, entry.mimeType);
    }
    content = withOutsideInMetadata(imported.markdown, layout);
    await container.writeDocument(content, layout.markdownFilename);
    sourcePath = layout.markdownPath;
  }

  const linked = withOutsideInMetadata(content, layout);
  if (linked !== content) {
    await api.writeDocument(sourcePath, linked);
    content = linked;
  }
  return {
    sourcePath,
    content,
    editingEnabled: isOutsideInMarkdownEditingEnabled(content),
  };
}

export function OutsideInDocumentDetail({
  path,
  layout,
  standalone,
}: {
  path: string;
  layout: OutsideInLayout;
  standalone: boolean;
}) {
  const [prepared, setPrepared] = useState<PreparedDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    setLoadError(null);
    setEnableError(null);
    void prepareDocument(path, layout)
      .then((next) => {
        if (!cancelled) setPrepared(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [layout, path]);

  const enableEditing = useCallback(async () => {
    if (!prepared || enabling) return;
    setEnabling(true);
    setEnableError(null);
    try {
      const listing = await api.listDocuments('', true);
      if (!listing.files.some((entry) => entry.path === layout.backupPath)) {
        const original = await api.fetchDocumentBlob(layout.targetPath);
        await api.writeDocumentBinary(
          layout.backupPath,
          original,
          original.type || 'application/octet-stream',
        );
      }
      const content = withOutsideInMarkdownEditing(prepared.content, layout);
      await api.writeDocument(prepared.sourcePath, content);
      setPrepared({ ...prepared, content, editingEnabled: true });
    } catch (error) {
      setEnableError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnabling(false);
    }
  }, [enabling, layout, prepared]);

  if (loadError) {
    return (
      <div className="placeholder">
        <p>
          Couldn't open <code>{path}</code>: {loadError}
        </p>
      </div>
    );
  }
  if (!prepared) return <p className="placeholder">Importing {path} for viewing…</p>;

  return (
    <OutsideInEditor
      key={`${prepared.sourcePath}:${prepared.editingEnabled ? 'editable' : 'readonly'}`}
      path={path}
      layout={layout}
      prepared={prepared}
      standalone={standalone}
      enabling={enabling}
      enableError={enableError}
      onEnableEditing={enableEditing}
    />
  );
}

function OutsideInEditor({
  path,
  layout,
  prepared,
  standalone,
  enabling,
  enableError,
  onEnableEditing,
}: {
  path: string;
  layout: OutsideInLayout;
  prepared: PreparedDocument;
  standalone: boolean;
  enabling: boolean;
  enableError: string | null;
  onEnableEditing: () => void | Promise<void>;
}) {
  const editorTheme = useEffectiveTheme();
  const container = useMemo(
    () =>
      createDocumentsContentContainer({
        root: layout.companionDirectory,
        client: api,
        primaryDocumentFilename: basename(prepared.sourcePath),
      }),
    [layout.companionDirectory, prepared.sourcePath],
  );
  const documentLinkProvider = useMemo(
    () => createDocumentLinkProvider({ client: api, currentDocumentPath: prepared.sourcePath }),
    [prepared.sourcePath],
  );
  const saveDocument = useCallback(
    async (source: string) => {
      const linked = withOutsideInMetadata(source, layout);
      const listing = await api.listDocuments('', true);
      const runtimePath =
        layout.format === 'html'
          ? runtimePathForTarget(
              layout.targetPath,
              new Set(
                listing.files
                  .filter((entry) => entry.isDirectory)
                  .map((entry) => entry.path.replace(/^\/+/, '')),
              ),
            )
          : undefined;
      const rendered = await renderOutsideInDocument(
        linked,
        layout,
        container,
        runtimePath ? relativePath(layout.parentDirectory, runtimePath) : undefined,
      );
      await api.writeDocument(prepared.sourcePath, linked);
      if (runtimePath) {
        const { PLAYER_BUNDLE } = await import('@bendyline/squisq-react/standalone-source');
        await api.writeDocument(runtimePath, PLAYER_BUNDLE);
      }
      await api.writeDocumentBinary(layout.targetPath, rendered.bytes, rendered.mimeType);
    },
    [container, layout, prepared.sourcePath],
  );
  const initialContent = useMemo(
    () => normalizeMarkdownBaseline(prepared.content),
    [prepared.content],
  );
  const autosave = useSerializedAutosave({
    resourceKey: `outside-in:documents:${prepared.sourcePath}`,
    initialValue: initialContent,
    save: saveDocument,
  });
  const handleChange = useCallback(
    (source: string) => {
      autosave.update(source);
    },
    [autosave.update],
  );

  return (
    <section className="document-detail" data-testid="document-detail">
      {!prepared.editingEnabled && (
        <output className="outside-in-readonly-banner">
          <span>
            <strong>{layout.format.toUpperCase()} preview · read-only.</strong> The original stays
            untouched until you enable outside-in editing.
          </span>
          {enableError && <span className="error">Could not enable editing: {enableError}</span>}
          <button type="button" disabled={enabling} onClick={() => void onEnableEditing()}>
            {enabling ? 'Preparing…' : 'Enable outside-in editing'}
          </button>
        </output>
      )}
      <div className="editor-wrap">
        <EditorShell
          initialMarkdown={autosave.desiredValue()}
          fileName={path}
          readOnly={!prepared.editingEnabled}
          onChange={prepared.editingEnabled ? handleChange : undefined}
          height="100%"
          colorScheme={editorTheme}
          fullWidth
          workspaceContainer={container}
          documentLinkProvider={documentLinkProvider}
          allowVersioning={prepared.editingEnabled}
          versionBasename={basename(prepared.sourcePath)}
          toolbarSlotAfterActions={
            <>
              {prepared.editingEnabled && <TransformToolbarButton context="generic" />}
              {!standalone && <PromoteToTabButton target={{ kind: 'document', path }} />}
            </>
          }
          statusBarSlotRight={
            prepared.editingEnabled ? <AutosaveStatus autosave={autosave} /> : undefined
          }
        />
      </div>
    </section>
  );
}
