import type { ComposedCodeContext, SecurityFindingWire } from '@bendyline/gezel';
import { EditorShell, useEditorContext } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { useEffect, useMemo, useRef } from 'react';
import { useEffectiveTheme } from '../../theme.js';

export interface SourceRevealRequest {
  path: string;
  line: number;
}

/**
 * Read-only squisq view of a file: EditorShell auto-selects by extension —
 * Monaco for code, the rich WYSIWYG surface for markdown/text. Keyed by path so
 * a new selection remounts (EditorShell reads `initialMarkdown` once at mount).
 * `codeContext` (per-symbol intelligence sections) may arrive after mount —
 * squisq reconciles its view zones on the prop update.
 */
export function FileSourceView({
  path,
  content,
  language,
  sourceReveal,
  findings,
  activeFinding,
  codeContext,
  onContextLink,
}: {
  path: string;
  content: string;
  language?: string;
  sourceReveal?: SourceRevealRequest;
  findings: SecurityFindingWire[];
  activeFinding: string | null;
  codeContext: ComposedCodeContext | null;
  onContextLink: (href: string) => boolean;
}) {
  const theme = useEffectiveTheme();
  const sections = useMemo(() => {
    if (!codeContext || (codeContext.sections.length === 0 && !codeContext.fileTop)) {
      return undefined;
    }
    return {
      ...(codeContext.fileTop ? { fileTop: codeContext.fileTop } : {}),
      sections: codeContext.sections,
      linkSchemes: ['gezel-nav'],
      onLinkClick: (href: string) => onContextLink(href),
    };
  }, [codeContext, onContextLink]);
  return (
    <EditorShell
      key={path}
      initialMarkdown={content}
      fileName={path}
      language={language}
      height="100%"
      colorScheme={theme}
      showPlayTab={false}
      showStatusBar={false}
      toolbarSlotLeft={
        <>
          <RevealEditorLine request={sourceReveal} />
          <HighlightEditorFindings findings={findings} activeFinding={activeFinding} />
        </>
      }
      fullWidth
      readOnly
      {...(sections ? { codeContext: sections } : {})}
    />
  );
}

/** Invisible host bridge that reveals a requested line after Monaco mounts. */
function RevealEditorLine({ request }: { request?: SourceRevealRequest }) {
  const { monacoEditor } = useEditorContext();
  useEffect(() => {
    if (!monacoEditor || !request) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const lineNumber = Math.min(request.line, model.getLineCount());
    monacoEditor.setPosition({ lineNumber, column: 1 });
    monacoEditor.revealLineInCenter(lineNumber);
  }, [monacoEditor, request]);
  return null;
}

/** Monaco line decorations for every active finding in the selected file. */
function HighlightEditorFindings({
  findings,
  activeFinding,
}: {
  findings: SecurityFindingWire[];
  activeFinding: string | null;
}) {
  const { monacoEditor } = useEditorContext();
  const decorationIds = useRef<string[]>([]);
  useEffect(() => {
    if (!monacoEditor) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const byLine = new Map<number, boolean>();
    for (const finding of findings) {
      if (finding.line == null) continue;
      const line = Math.min(finding.line, model.getLineCount());
      byLine.set(line, byLine.get(line) === true || finding.fingerprint === activeFinding);
    }
    decorationIds.current = monacoEditor.deltaDecorations(
      decorationIds.current,
      [...byLine].map(([line, active]) => ({
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: model.getLineMaxColumn(line),
        },
        options: {
          isWholeLine: true,
          className: active ? 'filemap-finding-line-active' : 'filemap-finding-line',
          linesDecorationsClassName: active
            ? 'filemap-finding-gutter-active'
            : 'filemap-finding-gutter',
        },
      })),
    );
    return () => {
      decorationIds.current = monacoEditor.deltaDecorations(decorationIds.current, []);
    };
  }, [activeFinding, findings, monacoEditor]);
  return null;
}
