import {
  type FileGraphResponse,
  type ShapedDiagram,
  buildDiagramTree,
  defaultDiagramExpansion,
  folderKindOf,
  shapeDiagram,
  visibleIdForPath,
} from '@bendyline/gezel';
import type { LayoutResult } from '@bendyline/squisq-graph';
import {
  DiagramViewer,
  type DiagramViewerHandle,
  useGraphLayout,
} from '@bendyline/squisq-react/graph';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import type { ProjectViewProps } from '../types.js';
import { type DiagramKind, type DiagramMode, DiagramToolbar } from './DiagramToolbar.js';
import { readDiagramExpansion, writeDiagramExpansion } from './diagram-memory.js';
import { DIAGRAM_LAYOUT_OPTIONS, type DiagramDrawing, drawingFor } from './diagram-model.js';
import { diagramLayoutEngine } from './layout-engine.js';
import '../../../styles/diagram-view.css';

const FOLDER_PREFIX = 'folder:';

/**
 * The Diagram view: the project's files as boxes and the imports between them
 * as arrows, folder by folder. Folders open and close in place; Focus shows
 * one file with what it uses and what uses it. A file opens in the shared
 * inspector. The graph comes from the index (`GET /index/graph`); its shaping
 * is core's `shapeDiagram`, and the layout runs in a worker.
 */
export default function DiagramProjectView({
  projectId,
  project,
  compact,
  selectedPath,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  const [kind, setKind] = useState<DiagramKind>(() =>
    folderKindOf(project) === 'documents' ? 'docs' : 'code',
  );
  const [tests, setTests] = useState(false);
  const [hideShortcuts, setHideShortcuts] = useState(true);
  const [mode, setMode] = useState<DiagramMode>('overview');
  const [depth, setDepth] = useState({ uses: 1, usedBy: 1 });
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [graph, setGraph] = useState<FileGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chosenOpen, setChosenOpen] = useState<Set<string> | null>(() =>
    readDiagramExpansion(projectId, kind),
  );
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const viewer = useRef<DiagramViewerHandle>(null);
  // A whole new picture (mode, focus, kind, filters) fits once it is drawn; a
  // folder opened in place keeps the camera, which the viewer holds itself.
  const refit = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getFileGraph(projectId, { kind, scope: tests ? 'all' : 'core', max: 2000 })
      .then(setGraph)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectId, kind, tests]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setInspectorExtras(null);
    return () => setInspectorExtras(null);
  }, [setInspectorExtras]);

  const tree = useMemo(() => (graph ? buildDiagramTree(graph) : null), [graph]);
  const open = useMemo(
    () => chosenOpen ?? (tree ? defaultDiagramExpansion(tree) : new Set<string>()),
    [chosenOpen, tree],
  );
  const focusing = mode === 'focus' && focusPath !== null;

  const shape = useMemo(() => {
    if (!graph || !tree) return null;
    return shapeDiagram(graph, tree, {
      expanded: open,
      hideShortcuts,
      focus: focusing ? { path: focusPath, ...depth } : null,
    });
  }, [graph, tree, open, hideShortcuts, focusing, focusPath, depth]);

  const drawing = useMemo(
    () => (shape ? drawingFor(shape, focusing ? focusPath : null) : null),
    [shape, focusing, focusPath],
  );
  const laid = useGraphLayout(drawing?.graph ?? null, DIAGRAM_LAYOUT_OPTIONS, {
    engine: diagramLayoutEngine(),
  });

  // Draw a layout only with the presentation it was computed for.
  const [shown, setShown] = useState<{ layout: LayoutResult; drawing: DiagramDrawing } | null>(
    null,
  );
  useEffect(() => {
    if (laid.layout && !laid.pending && drawing) setShown({ layout: laid.layout, drawing });
  }, [laid.layout, laid.pending, drawing]);
  useEffect(() => {
    if (!shown || !refit.current) return;
    refit.current = false;
    viewer.current?.fit();
  }, [shown]);

  const setOpen = (next: Set<string> | null) => {
    setChosenOpen(next);
    writeDiagramExpansion(projectId, kind, next);
  };

  const chooseKind = (next: DiagramKind) => {
    if (next === kind) return;
    refit.current = true;
    setKind(next);
    setChosenOpen(readDiagramExpansion(projectId, next));
    setMode('overview');
  };

  const selectedId = useMemo(() => {
    if (selectedFolder) return selectedFolder;
    if (!selectedPath || !tree) return null;
    return focusing ? selectedPath : visibleIdForPath(tree, open, selectedPath);
  }, [selectedFolder, selectedPath, tree, focusing, open]);

  // A file chosen in another view, or in the inspector, comes into sight.
  const shownLayout = shown?.layout;
  useEffect(() => {
    if (selectedId && shownLayout?.nodes.some((n) => n.id === selectedId)) {
      viewer.current?.reveal(selectedId);
    }
  }, [selectedId, shownLayout]);

  const highlightIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !shape) return undefined;
    return shape.nodes.filter((n) => n.path.toLowerCase().includes(q)).map((n) => n.id);
  }, [query, shape]);

  const onSelectionChange = (ids: string[]) => {
    const id = ids[ids.length - 1] ?? null;
    if (id?.startsWith(FOLDER_PREFIX)) {
      setSelectedFolder(id);
      return;
    }
    setSelectedFolder(null);
    onSelectPath(id);
  };

  const focusOn = (path: string) => {
    refit.current = true;
    setFocusPath(path);
    setMode('focus');
    setSelectedFolder(null);
    onSelectPath(path);
  };

  const onNodeActivate = (id: string) => {
    if (id.startsWith(FOLDER_PREFIX)) toggleFolder(id, true);
    else focusOn(id);
  };

  const toggleFolder = (id: string, expanded: boolean) => {
    viewer.current?.keepInPlace(id);
    const path = id.slice(FOLDER_PREFIX.length);
    const next = new Set(open);
    if (expanded) next.add(path);
    else next.delete(path);
    setOpen(next);
  };

  const onMode = (next: DiagramMode) => {
    if (next === 'focus') {
      const center = selectedPath ?? focusPath;
      if (!center) return;
      focusOn(center);
      return;
    }
    refit.current = true;
    setMode('overview');
  };

  const onFind = () => {
    const first = highlightIds?.find((id) => !id.startsWith(FOLDER_PREFIX)) ?? highlightIds?.[0];
    if (!first) return;
    onSelectionChange([first]);
    viewer.current?.reveal(first);
  };

  const describeNode = useCallback(
    (id: string): string => {
      const node = shape?.nodes.find((n) => n.id === id);
      if (!node) return id;
      return node.kind === 'folder'
        ? `${node.label} folder, ${node.fileCount} files`
        : `${node.path}${node.inCycle ? ', in an import cycle' : ''}`;
    },
    [shape],
  );

  const status = shape ? statusLine(shape, graph) : null;

  return (
    <section className={compact ? 'diagram-view diagram-view--compact' : 'diagram-view'}>
      <DiagramToolbar
        mode={focusing ? 'focus' : 'overview'}
        onMode={onMode}
        canFocus={!!(selectedPath ?? focusPath)}
        uses={depth.uses}
        usedBy={depth.usedBy}
        onDepth={(uses, usedBy) => {
          refit.current = true;
          setDepth({ uses, usedBy });
        }}
        kind={kind}
        onKind={chooseKind}
        tests={tests}
        onTests={(on) => {
          refit.current = true;
          setTests(on);
        }}
        hideShortcuts={hideShortcuts}
        onHideShortcuts={setHideShortcuts}
        query={query}
        onQuery={setQuery}
        onFind={onFind}
        onFit={() => viewer.current?.fit()}
        onCollapseAll={() => {
          refit.current = true;
          setOpen(new Set());
        }}
        onReset={() => {
          refit.current = true;
          setOpen(null);
        }}
      />
      {status && (
        <p className="diagram-status">
          {status}
          {laid.slow && <span className="diagram-status-busy"> · Arranging…</span>}
        </p>
      )}
      <DiagramBody
        error={error}
        loading={loading}
        graph={graph}
        kind={kind}
        empty={!!shape && shape.nodes.length === 0}
        onRetry={load}
      >
        {shown && (
          <DiagramViewer
            ref={viewer}
            className="diagram-canvas"
            layout={shown.layout}
            nodes={shown.drawing.nodes}
            edges={shown.drawing.edges}
            selectedIds={selectedId ? [selectedId] : []}
            onSelectionChange={onSelectionChange}
            onNodeActivate={onNodeActivate}
            onContainerToggle={toggleFolder}
            highlightIds={highlightIds}
            ariaLabel={kind === 'docs' ? 'How documents link' : 'How files depend on each other'}
            describeNode={describeNode}
          />
        )}
      </DiagramBody>
    </section>
  );
}

function statusLine(shape: ShapedDiagram, graph: FileGraphResponse | null): string {
  const { stats } = shape;
  const parts = [`${stats.files} files`];
  if (stats.cycles > 0) parts.push(`${stats.cycles} import cycle${stats.cycles === 1 ? '' : 's'}`);
  if (stats.hubs.length > 0) {
    const labels = [
      ...new Set(
        stats.hubs.map((id) => {
          const node = shape.nodes.find((n) => n.id === id);
          return node?.kind === 'folder' ? `${node.label}/` : (node?.label ?? id);
        }),
      ),
    ];
    parts.push(
      labels.length <= 3
        ? `lines into ${labels.join(', ')} left out`
        : `lines into ${labels.length} widely used boxes left out`,
    );
  }
  if (stats.shortcutsHidden > 0) {
    parts.push(`${stats.shortcutsHidden} shortcut${stats.shortcutsHidden === 1 ? '' : 's'} hidden`);
  }
  if (graph?.truncated) parts.push(`the ${graph.nodes.length} busiest files shown`);
  if (graph && !graph.resolved) parts.push('only relative imports so far');
  return parts.join(' · ');
}

function DiagramBody({
  error,
  loading,
  graph,
  kind,
  empty,
  onRetry,
  children,
}: {
  error: string | null;
  loading: boolean;
  graph: FileGraphResponse | null;
  kind: DiagramKind;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div className="diagram-empty">
        <p>Couldn’t load the diagram: {error}</p>
        <button type="button" className="gz-key" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="diagram-empty">{loading ? <p>Reading how files connect…</p> : null}</div>
    );
  }
  if (!graph.indexed) {
    return (
      <div className="diagram-empty">
        <p>
          Gezel hasn’t read this folder yet. Once it has, the diagram shows how its files connect.
        </p>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="diagram-empty">
        <p>
          {kind === 'docs'
            ? 'No documents here link to each other.'
            : 'No code files to draw here. Documents may link to each other instead.'}
        </p>
      </div>
    );
  }
  return <div className="diagram-stage">{children}</div>;
}
