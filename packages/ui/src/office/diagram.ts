/**
 * Mermaid diagrams as pictures for Word.
 *
 * Drawn here in the pane, which has a DOM to lay text out in, and inserted as
 * an ordinary PNG: picture import is the one diagram path every Word on every
 * OS takes. Labels are SVG text, not HTML: Mermaid's default HTML labels sit
 * in `foreignObject`, which WebKit refuses to rasterize (the canvas is
 * tainted and cannot be exported), and Word's own SVG import drops them.
 */

export interface RenderedDiagram {
  /** PNG bytes, base64, without a `data:` prefix. */
  base64: string;
  widthPt: number;
  heightPt: number;
  diagramType: string;
}

export type DiagramRenderer = (source: string) => Promise<RenderedDiagram>;

/** Text width of a Letter page inside Word's default one-inch margins. */
export const MAX_DIAGRAM_WIDTH_PT = 468;
const PX_TO_PT = 0.75;
const PIXEL_RATIO = 2;
const MAX_CANVAS_SIDE = 4096;

type Mermaid = typeof import('mermaid')['default'];

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'neutral',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          fontFamily: 'Aptos, Calibri, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
        });
        return mermaid;
      })
      .catch((err: unknown) => {
        mermaidPromise = null;
        throw err;
      });
  }
  return mermaidPromise;
}

/** The diagram's size in CSS pixels, from the root element's viewBox. */
export function svgSize(svg: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const box = /\bviewBox\s*=\s*"([^"]+)"/i
    .exec(root)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0) {
    throw new Error('the diagram came out with no size');
  }
  return { width: box[2]!, height: box[3]! };
}

/** Pin the root element to its natural size so it rasterizes at that size. */
export function withIntrinsicSize(svg: string, width: number, height: number): string {
  return svg.replace(/<svg\b[^>]*>/i, (tag) => {
    const bare = tag
      .replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, '')
      .replace(/\sstyle="[^"]*"/i, '');
    const ns = /\sxmlns\s*=/.test(bare) ? '' : ' xmlns="http://www.w3.org/2000/svg"';
    return bare.replace(/^<svg\b/i, `<svg${ns} width="${width}" height="${height}"`);
  });
}

/** Points on the page: natural size, scaled down to fit the text width. */
export function pageSize(width: number, height: number): { widthPt: number; heightPt: number } {
  const scale = Math.min(1, MAX_DIAGRAM_WIDTH_PT / (width * PX_TO_PT));
  return {
    widthPt: Math.round(width * PX_TO_PT * scale * 10) / 10,
    heightPt: Math.round(height * PX_TO_PT * scale * 10) / 10,
  };
}

async function rasterize(svg: string, width: number, height: number): Promise<string> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('the drawn diagram could not be loaded as an image'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withIntrinsicSize(svg, width, height))}`;
  });
  const scale = Math.min(PIXEL_RATIO, MAX_CANVAS_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this Office cannot draw pictures');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

function firstLines(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    raw
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(0, 6)
      .join('\n') || 'unknown error'
  );
}

let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

/**
 * Draw Mermaid source as a PNG sized for the page. Calls run one at a time:
 * Mermaid keeps global state, and two renders at once corrupt each other.
 * A source Mermaid cannot parse is reported with Mermaid's own message, so
 * the model can correct it.
 */
export const renderMermaidPng: DiagramRenderer = (source) => {
  const run = async (): Promise<RenderedDiagram> => {
    const mermaid = await loadMermaid();
    const id = `gezel-diagram-${++sequence}`;
    let rendered: { svg: string; diagramType: string };
    try {
      rendered = await mermaid.render(id, source);
    } catch (err) {
      throw new Error(`The diagram could not be drawn. Mermaid says:\n${firstLines(err)}`);
    } finally {
      document.getElementById(`d${id}`)?.remove();
    }
    const { width, height } = svgSize(rendered.svg);
    const base64 = await rasterize(rendered.svg, width, height);
    return { base64, ...pageSize(width, height), diagramType: rendered.diagramType };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
};
