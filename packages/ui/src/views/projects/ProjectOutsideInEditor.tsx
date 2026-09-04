import { EditorShell } from '@bendyline/squisq-editor-react';
import { createMediaProviderFromContainer } from '@bendyline/squisq/storage';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo } from 'react';
import { api } from '../../api.js';
import { AutosaveStatus } from '../../components/AutosaveStatus.js';
import { ExportToolbarControls } from '../../components/DocumentExport/index.js';
import { DocumentNarration } from '../../components/DocumentNarration.js';
import { ironCalcEngineFactory } from '../../components/SquisqIntegration/calculation.js';
import {
  type OutsideInLayout,
  createDataReferenceContainer,
  createDocumentLinkProvider,
  createProjectContentContainer,
  createVersionCompatibleContentContainer,
  documentVersionBasename,
} from '../../components/SquisqIntegration/index.js';
import { normalizeMarkdownBaseline } from '../../components/markdown-baseline.js';
import { TransformToolbarButton } from '../../components/transform/TransformToolbarButton.js';
import { useSerializedAutosave } from '../../hooks/useSerializedAutosave.js';

interface ProjectOutsideInEditorProps {
  projectId: string;
  file: {
    path: string;
    content: string;
    source: 'workspace' | 'artifacts';
  };
  outsideIn: {
    layout: OutsideInLayout;
    sourcePath: string;
  };
  isReadOnly: boolean;
  editorTheme: 'light' | 'dark';
  onChange: (source: string) => void;
  onSave: (content?: string) => void | Promise<void>;
  toolbarIndexToggle?: ReactNode;
}

/** Editor for a rendered document's editable Markdown companion. */
export function ProjectOutsideInEditor({
  projectId,
  file,
  outsideIn,
  isReadOnly,
  editorTheme,
  onChange,
  onSave,
  toolbarIndexToggle,
}: ProjectOutsideInEditorProps) {
  const { layout, sourcePath } = outsideIn;
  const autosave = useSerializedAutosave({
    resourceKey: `outside-in:${projectId}:${file.source}:${sourcePath}`,
    initialValue: normalizeMarkdownBaseline(file.content),
    save: async (content) => {
      await onSave(content);
    },
  });
  const handleChange = useCallback(
    (content: string) => {
      onChange(content);
      autosave.update(content);
    },
    [autosave.update, onChange],
  );
  const container = useMemo(
    () =>
      createProjectContentContainer({
        projectId,
        root: layout.companionDirectory,
        client: api,
        primaryDocumentFilename: basenameOf(sourcePath),
        source: file.source,
      }),
    [file.source, layout.companionDirectory, projectId, sourcePath],
  );
  const dataReferenceContainer = useMemo(
    () => createDataReferenceContainer(container),
    [container],
  );
  const versionBasename = useMemo(() => documentVersionBasename(sourcePath), [sourcePath]);
  const versionContainer = useMemo(
    () => createVersionCompatibleContentContainer(dataReferenceContainer, versionBasename),
    [dataReferenceContainer, versionBasename],
  );
  const mediaProvider = useMemo(
    () => createMediaProviderFromContainer(dataReferenceContainer),
    [dataReferenceContainer],
  );
  useEffect(() => () => mediaProvider.dispose(), [mediaProvider]);
  const documentLinkProvider = useMemo(
    () =>
      file.source === 'artifacts'
        ? createDocumentLinkProvider({
            client: api,
            currentDocumentPath: sourcePath,
            source: 'project-artifacts',
            projectId,
          })
        : undefined,
    [file.source, projectId, sourcePath],
  );
  return (
    <div className="editor-wrap" style={{ height: '100%' }}>
      <EditorShell
        initialMarkdown={autosave.desiredValue()}
        // Detect the mode from the Markdown companion, not the rendered target.
        fileName={sourcePath}
        initialView="wysiwyg"
        readOnly={isReadOnly}
        onChange={isReadOnly ? undefined : handleChange}
        height="100%"
        colorScheme={editorTheme}
        fullWidth
        workspaceContainer={versionContainer}
        mediaProvider={mediaProvider}
        documentLinkProvider={documentLinkProvider}
        calcEngineFactory={isReadOnly ? undefined : ironCalcEngineFactory}
        allowVersioning={!isReadOnly}
        versionBasename={versionBasename}
        outline
        toolbarSlotAfterActions={
          <>
            {!isReadOnly && <TransformToolbarButton context="generic" />}
            <DocumentNarration fileName={file.path} projectId={projectId} />
          </>
        }
        toolbarSlotRight={
          <>
            {toolbarIndexToggle}
            {!isReadOnly && <AutosaveStatus autosave={autosave} />}
            {!isReadOnly && (
              <button
                type="button"
                onClick={() => void autosave.flush()}
                style={{ marginLeft: '0.5rem' }}
              >
                Save {layout.format.toUpperCase()}
              </button>
            )}
            {file.source === 'artifacts' && (
              <ExportToolbarControls
                selectedFile={file.path}
                mediaContainer={dataReferenceContainer}
                mediaSource={{ kind: 'project-artifacts', projectId }}
              />
            )}
          </>
        }
      />
    </div>
  );
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}
