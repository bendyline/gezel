import type { DiagramNodeShape, ShapedDiagram } from '@bendyline/gezel';
import type { LayoutGraph, LayoutOptions } from '@bendyline/squisq-graph';
import {
  type GraphTone,
  type GraphViewEdge,
  type GraphViewNode,
  estimateTextWidth,
  graphNodeSize,
} from '@bendyline/squisq-react/graph';

/** What the viewer needs: the graph to lay out and how each part is drawn. */
export interface DiagramDrawing {
  graph: LayoutGraph;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

/** One object, so the layout cache sees the same options every time. */
export const DIAGRAM_LAYOUT_OPTIONS: LayoutOptions = Object.freeze({
  direction: 'right',
  portSharing: 'container',
});

const SEVERITY_TONE: Record<string, GraphTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'notice',
  info: 'notice',
};

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function folderTitle(node: DiagramNodeShape): string {
  const purpose = node.folder?.purpose;
  return purpose ? `${node.path}/\n${purpose}` : `${node.path}/`;
}

/** The view of one shaped node, and the box the layout should give it. */
function drawNode(
  node: DiagramNodeShape,
  focusPath: string | null,
): { view: GraphViewNode; width: number; height: number } {
  if (node.kind === 'folder' && node.open) {
    const view: GraphViewNode = {
      id: node.id,
      label: `${node.label}/`,
      badge: String(node.fileCount),
      expandable: true,
      expanded: true,
      title: folderTitle(node),
    };
    // A frame's own size is only its floor: the layout grows it around its contents.
    return { view, width: Math.ceil(estimateTextWidth(view.label) + 64), height: 24 };
  }
  if (node.kind === 'folder') {
    const view: GraphViewNode = {
      id: node.id,
      label: `${node.label}/`,
      detail: plural(node.fileCount, 'file'),
      expandable: true,
      expanded: false,
      title: folderTitle(node),
      ...(node.inCycle ? { tone: 'warning' as const } : {}),
    };
    return { view, ...graphNodeSize(view) };
  }
  const file = node.file!;
  const badge =
    file.findings > 0
      ? String(file.findings)
      : node.hiddenNeighbors > 0
        ? `+${node.hiddenNeighbors}`
        : undefined;
  const tone: GraphTone | undefined =
    node.path === focusPath
      ? 'accent'
      : file.maxSeverity && file.findings > 0
        ? SEVERITY_TONE[file.maxSeverity]
        : undefined;
  const view: GraphViewNode = {
    id: node.id,
    label: node.label,
    title: file.lead ? `${node.path}\n${file.lead}` : node.path,
    ...(badge ? { badge } : {}),
    ...(tone ? { tone } : {}),
    ...(node.hub ? { detail: `Used by ${node.stubbedIn}` } : {}),
  };
  return { view, ...graphNodeSize(view) };
}

export function drawingFor(shape: ShapedDiagram, focusPath: string | null): DiagramDrawing {
  const nodes: GraphViewNode[] = [];
  const layoutNodes: LayoutGraph['nodes'][number][] = [];
  for (const node of shape.nodes) {
    const { view, width, height } = drawNode(node, focusPath);
    nodes.push(view);
    layoutNodes.push({
      id: node.id,
      width,
      height,
      ...(node.parent ? { parent: node.parent } : {}),
    });
  }
  const edges: GraphViewEdge[] = shape.edges.map((e) => {
    const first = e.sample[0];
    const what = first ? `${base(first.source)} → ${base(first.target)}` : '';
    const more = e.weight > 1 ? ` and ${e.weight - 1} more` : '';
    const notes = [e.typeOnly ? 'types only' : '', e.cycle ? 'part of an import cycle' : '']
      .filter(Boolean)
      .join(', ');
    return {
      id: e.id,
      weight: e.weight,
      title: `${what}${more}${notes ? ` (${notes})` : ''}`,
      ...(e.typeOnly ? { dashed: true } : {}),
      ...(e.bidirectional ? { bidirectional: true } : {}),
      ...(e.cycle ? { tone: 'warning' as const } : {}),
    };
  });
  return {
    graph: {
      nodes: layoutNodes,
      edges: shape.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        weight: e.weight,
      })),
    },
    nodes,
    edges,
  };
}
