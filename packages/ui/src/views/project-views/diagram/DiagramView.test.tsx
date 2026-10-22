import type {
  FileGraphEdge,
  FileGraphNode,
  FileGraphResponse,
  ProjectDetail,
  ShapedDiagram,
} from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawingFor } from './diagram-model.js';
import DiagramProjectView from './index.js';

vi.mock('../../../api.js', () => ({ api: { getFileGraph: vi.fn() } }));
vi.mock('./layout-engine.js', async () => {
  const { createInlineLayoutEngine } = await import('@bendyline/squisq-graph');
  const engine = createInlineLayoutEngine();
  return { diagramLayoutEngine: () => engine };
});

const { api } = await import('../../../api.js');
const getFileGraph = vi.mocked(api.getFileGraph);

// jsdom has no PointerEvent; without one, fired pointer events lose their
// buttons, coordinates and modifier keys.
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventStandIn extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    window.PointerEvent = PointerEventStandIn as unknown as typeof PointerEvent;
  }
});

function file(id: string, extra: Partial<FileGraphNode> = {}): FileGraphNode {
  const slash = id.lastIndexOf('/');
  return {
    id,
    label: id.slice(slash + 1),
    folder: slash < 0 ? '' : id.slice(0, slash),
    lang: 'typescript',
    modality: 'code',
    use: 'code',
    test: false,
    loc: 10,
    fanIn: 0,
    fanOut: 0,
    importance: 0.1,
    findings: 0,
    maxSeverity: null,
    ...extra,
  };
}

function edge(source: string, target: string, extra: Partial<FileGraphEdge> = {}): FileGraphEdge {
  return {
    source,
    target,
    kind: 'import',
    names: [],
    nameCount: 0,
    typeOnly: false,
    dynamic: false,
    reexport: false,
    ...extra,
  };
}

const GRAPH: FileGraphResponse = {
  indexed: true,
  builtAt: '2026-10-21T00:00:00Z',
  kind: 'code',
  scope: 'core',
  resolved: true,
  partial: false,
  nodes: [
    file('src/main.ts'),
    file('src/app.ts', { findings: 2, maxSeverity: 'high' }),
    file('lib/util.ts'),
    file('lib/format.ts'),
  ],
  edges: [
    edge('src/main.ts', 'src/app.ts'),
    edge('src/app.ts', 'lib/util.ts'),
    edge('lib/util.ts', 'lib/format.ts', { typeOnly: true }),
  ],
  externals: [],
  folders: [],
  packageRoots: [],
  coverage: {},
  signature: 's1',
  truncated: null,
};

const project = { id: 'p1', name: 'Demo', packages: [] } as unknown as ProjectDetail;

function renderDiagram(selectedPath: string | null = null) {
  const onSelectPath = vi.fn();
  const utils = render(
    <DiagramProjectView
      projectId="p1"
      project={project}
      compact={false}
      selectedPath={selectedPath}
      onSelectPath={onSelectPath}
      setInspectorExtras={vi.fn()}
    />,
  );
  return { ...utils, onSelectPath };
}

const boxLabeled = (container: HTMLElement, label: string): Element | undefined =>
  [...container.querySelectorAll('.gv-node, .gv-container')].find(
    (g) => g.querySelector(':scope > text')?.textContent === label,
  );

function click(el: Element) {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(el, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
}

beforeEach(() => {
  getFileGraph.mockReset();
  window.localStorage.clear();
});

describe('DiagramProjectView', () => {
  it('draws the project, opening small projects all the way', async () => {
    getFileGraph.mockResolvedValue(GRAPH);
    const { container } = renderDiagram();
    await waitFor(() => expect(container.querySelectorAll('.gv-node')).toHaveLength(4));
    expect(container.querySelectorAll('.gv-container')).toHaveLength(2);
    expect(container.querySelectorAll('.gv-edge')).toHaveLength(3);
    expect(container.querySelector('.gv-edge[data-dashed]')).not.toBeNull();
    expect(getFileGraph).toHaveBeenCalledWith('p1', { kind: 'code', scope: 'core', max: 2000 });
    expect(screen.getByText(/4 files/)).toBeInTheDocument();
  });

  it('opens a file in the inspector and focuses on it on double-click', async () => {
    getFileGraph.mockResolvedValue(GRAPH);
    const { container, onSelectPath } = renderDiagram();
    await waitFor(() => expect(boxLabeled(container, 'app.ts')).toBeDefined());
    click(boxLabeled(container, 'app.ts')!);
    expect(onSelectPath).toHaveBeenLastCalledWith('src/app.ts');

    fireEvent.doubleClick(boxLabeled(container, 'app.ts')!);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Focus' })).toHaveAttribute('aria-checked', 'true'),
    );
    // Focus keeps app.ts, what it uses (util.ts) and what uses it (main.ts).
    await waitFor(() => expect(container.querySelectorAll('.gv-node')).toHaveLength(3));
    expect(boxLabeled(container, 'format.ts')).toBeUndefined();
  });

  it('closes a folder in place and remembers it', async () => {
    getFileGraph.mockResolvedValue(GRAPH);
    const { container } = renderDiagram();
    await waitFor(() => expect(container.querySelectorAll('.gv-container')).toHaveLength(2));
    const lib = boxLabeled(container, 'lib/')!;
    click(lib.querySelector('.gv-toggle rect')!);
    await waitFor(() => expect(container.querySelectorAll('.gv-container')).toHaveLength(1));
    expect(boxLabeled(container, 'lib/')?.getAttribute('data-collapsed')).toBe('');
    expect(JSON.parse(window.localStorage.getItem('gezel.diagram.open.p1.code')!)).toEqual(['src']);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    await waitFor(() => expect(container.querySelectorAll('.gv-container')).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(container.querySelectorAll('.gv-container')).toHaveLength(2));
    expect(window.localStorage.getItem('gezel.diagram.open.p1.code')).toBeNull();
  });

  it('switches to document links and asks for tests when told to', async () => {
    getFileGraph.mockResolvedValue(GRAPH);
    renderDiagram();
    await waitFor(() => expect(getFileGraph).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('radio', { name: 'Documents' }));
    await waitFor(() =>
      expect(getFileGraph).toHaveBeenLastCalledWith('p1', {
        kind: 'docs',
        scope: 'core',
        max: 2000,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tests' }));
    await waitFor(() =>
      expect(getFileGraph).toHaveBeenLastCalledWith('p1', {
        kind: 'docs',
        scope: 'all',
        max: 2000,
      }),
    );
  });

  it('finds a file and selects the first match on Enter', async () => {
    getFileGraph.mockResolvedValue(GRAPH);
    const { container, onSelectPath } = renderDiagram();
    await waitFor(() => expect(container.querySelectorAll('.gv-node')).toHaveLength(4));
    const find = screen.getByRole('searchbox', { name: 'Find a file in the diagram' });
    fireEvent.change(find, { target: { value: 'format' } });
    expect(container.querySelector('.squisq-graph-view')).toHaveAttribute('data-dim');
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(onSelectPath).toHaveBeenLastCalledWith('lib/format.ts');
  });

  it('says so when the folder is not indexed, and offers a retry on error', async () => {
    getFileGraph.mockResolvedValueOnce({ ...GRAPH, indexed: false, nodes: [], edges: [] });
    const first = renderDiagram();
    expect(await screen.findByText(/hasn’t read this folder yet/)).toBeInTheDocument();
    first.unmount();

    getFileGraph.mockRejectedValueOnce(new Error('offline'));
    renderDiagram();
    expect(await screen.findByText(/Couldn’t load the diagram: offline/)).toBeInTheDocument();
    getFileGraph.mockResolvedValueOnce(GRAPH);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByText(/4 files/)).toBeInTheDocument();
  });
});

describe('drawingFor', () => {
  const shape: ShapedDiagram = {
    nodes: [
      {
        id: 'folder:src',
        kind: 'folder',
        path: 'src',
        label: 'src',
        parent: null,
        open: true,
        fileCount: 2,
        hub: false,
        stubbedIn: 0,
        hiddenNeighbors: 0,
        inCycle: false,
      },
      {
        id: 'src/a.ts',
        kind: 'file',
        path: 'src/a.ts',
        label: 'a.ts',
        parent: 'folder:src',
        open: false,
        fileCount: 1,
        file: file('src/a.ts', { findings: 3, maxSeverity: 'medium', lead: 'Does a.' }),
        hub: false,
        stubbedIn: 0,
        hiddenNeighbors: 0,
        inCycle: false,
      },
      {
        id: 'folder:lib',
        kind: 'folder',
        path: 'lib',
        label: 'lib',
        parent: null,
        open: false,
        fileCount: 7,
        hub: true,
        stubbedIn: 14,
        hiddenNeighbors: 0,
        inCycle: true,
      },
    ],
    edges: [
      {
        id: 'src/a.ts>folder:lib',
        source: 'src/a.ts',
        target: 'folder:lib',
        weight: 4,
        typeOnly: false,
        dynamic: false,
        bidirectional: true,
        cycle: true,
        sample: [{ source: 'src/a.ts', target: 'lib/x.ts' }],
      },
    ],
    stats: {
      files: 9,
      visibleFiles: 1,
      fileEdges: 4,
      internalEdges: 0,
      shortcutsHidden: 0,
      hubs: [],
      cycles: 1,
    },
  };

  it('turns shaped boxes and edges into a layout graph and their presentation', () => {
    const drawing = drawingFor(shape, null);
    const [src, a, lib] = drawing.nodes;
    expect(src).toMatchObject({ label: 'src/', expandable: true, expanded: true, badge: '2' });
    expect(a).toMatchObject({
      label: 'a.ts',
      badge: '3',
      tone: 'warning',
      title: 'src/a.ts\nDoes a.',
    });
    expect(lib).toMatchObject({
      label: 'lib/',
      detail: '7 files',
      expanded: false,
      tone: 'warning',
    });
    expect(drawing.graph.nodes[1]).toMatchObject({ id: 'src/a.ts', parent: 'folder:src' });
    expect(drawing.graph.nodes.every((n) => n.width > 0 && n.height > 0)).toBe(true);
    expect(drawing.edges[0]).toMatchObject({
      weight: 4,
      bidirectional: true,
      tone: 'warning',
      title: 'a.ts → x.ts and 3 more (part of an import cycle)',
    });
    expect(drawing.graph.edges[0]).toEqual({
      id: 'src/a.ts>folder:lib',
      source: 'src/a.ts',
      target: 'folder:lib',
      weight: 4,
    });
  });

  it('marks the focus file', () => {
    expect(drawingFor(shape, 'src/a.ts').nodes[1]!.tone).toBe('accent');
  });
});
