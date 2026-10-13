/**
 * The paper a piece of catalog artwork is drawn on, so a surface can sit on
 * the same ground and the artwork bleeds into it instead of reading as a
 * pasted-on square. Workshop Marks are still-lifes on laid rag paper whose
 * tone drifts per book (roughly #d4c0a6 to #f2ead6), and props such as a
 * ruler or magnifier often run off the edge, so the ground is the dominant
 * color cluster along the border rather than a plain average.
 */

type Rgb = [number, number, number];

const SAMPLE_SIZE = 32;
const BUCKET = 12;
/** Below this share of the border, there is no single ground to match. */
const MIN_SHARE = 0.4;
/** The surface sets warm ink on the paper, so only a light ground qualifies. */
const MIN_LUMINANCE = 0.6;

const bucketKey = (r: number, g: number, b: number) => `${r},${g},${b}`;

export function paperFromEdgePixels(
  data: ArrayLike<number>,
  width: number,
  height: number,
): string | null {
  if (width < 2 || height < 2) return null;
  const buckets = new Map<string, { at: Rgb; colors: Rgb[] }>();
  let total = 0;
  const visit = (x: number, y: number) => {
    total += 1;
    const offset = (y * width + x) * 4;
    if ((data[offset + 3] ?? 0) < 250) return;
    const color: Rgb = [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
    const at = color.map((channel) => Math.floor(channel / BUCKET)) as Rgb;
    const key = bucketKey(...at);
    const bucket = buckets.get(key);
    if (bucket) bucket.colors.push(color);
    else buckets.set(key, { at, colors: [color] });
  };
  for (let x = 0; x < width; x += 1) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(0, y);
    visit(width - 1, y);
  }

  // A bucket edge can split one paper tone in two, so each candidate
  // counts its neighbors as well.
  let ground: Rgb[] = [];
  for (const { at } of buckets.values()) {
    const colors: Rgb[] = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dg = -1; dg <= 1; dg += 1) {
        for (let db = -1; db <= 1; db += 1) {
          const neighbor = buckets.get(bucketKey(at[0] + dr, at[1] + dg, at[2] + db));
          if (neighbor) colors.push(...neighbor.colors);
        }
      }
    }
    if (colors.length > ground.length) ground = colors;
  }
  if (ground.length === 0 || ground.length / total < MIN_SHARE) return null;

  const mean = (channel: 0 | 1 | 2) =>
    Math.round(ground.reduce((sum, color) => sum + color[channel], 0) / ground.length);
  const [r, g, b] = [mean(0), mean(1), mean(2)];
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < MIN_LUMINANCE ? null : `rgb(${r} ${g} ${b})`;
}

/** Null when the image cannot be read (a tainted or unsupported canvas). */
export function sampleArtworkPaper(image: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return paperFromEdgePixels(data, SAMPLE_SIZE, SAMPLE_SIZE);
  } catch {
    return null;
  }
}
