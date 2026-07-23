import { z } from 'zod';

/**
 * Image rendering — a unified composition that flattens ordered layers
 * into a single PNG/JPEG. See `packages/service/src/rendering/` for the
 * Playwright + resvg implementation.
 */

const ColorStringSchema = z
  .string()
  .min(1)
  .describe('CSS color — hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or the keyword "transparent".');

const LayerCommonSchema = {
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  opacity: z.number().min(0).max(1).optional(),
};

export const SvgLayerSchema = z.object({
  kind: z.literal('svg'),
  svg: z
    .string()
    .min(1)
    .describe('SVG markup. <script>/<foreignObject>/event handlers are stripped.'),
  rotate: z.number().optional().describe('Degrees of rotation around the layer center.'),
  ...LayerCommonSchema,
});
export type SvgLayer = z.infer<typeof SvgLayerSchema>;

export const HtmlLayerSchema = z.object({
  kind: z.literal('html'),
  html: z.string().min(1).describe('HTML fragment rendered inside a sandboxed iframe.'),
  ...LayerCommonSchema,
});
export type HtmlLayer = z.infer<typeof HtmlLayerSchema>;

export const PixelsLayerSchema = z.object({
  kind: z.literal('pixels'),
  rows: z
    .array(z.string())
    .min(1)
    .describe(
      'Pixel grid as a JSON array of strings; one row per string, one character per cell. ' +
        'Every character must appear as a key in `palette`.',
    ),
  palette: z
    .record(z.string(), ColorStringSchema)
    .describe(
      'Map from single-character keys in `rows` to CSS colors. ' +
        'Mnemonic letters ("r"=red, "w"=white, "g"=green) are encouraged. ' +
        'Use "transparent" for empty cells.',
    ),
  scale: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Pixel size in output px. Defaults to a value that fits the canvas.'),
  ...LayerCommonSchema,
});
export type PixelsLayer = z.infer<typeof PixelsLayerSchema>;

export const ImageLayerSchema = z.object({
  kind: z.literal('image'),
  artifactPath: z
    .string()
    .min(1)
    .describe('Path to a previously-written artifact, relative to the project artifacts/ root.'),
  ...LayerCommonSchema,
});
export type ImageLayer = z.infer<typeof ImageLayerSchema>;

export const TextLayerSchema = z.object({
  kind: z.literal('text'),
  text: z.string().min(1),
  x: z.number(),
  y: z.number(),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  color: ColorStringSchema.optional(),
  weight: z.number().int().optional(),
  opacity: z.number().min(0).max(1).optional(),
});
export type TextLayer = z.infer<typeof TextLayerSchema>;

export const LayerSchema = z.discriminatedUnion('kind', [
  SvgLayerSchema,
  HtmlLayerSchema,
  PixelsLayerSchema,
  ImageLayerSchema,
  TextLayerSchema,
]);
export type Layer = z.infer<typeof LayerSchema>;

export const RenderImageRequestSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe('Project to save the artifact under. Defaults to "default".'),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  layers: z.array(LayerSchema).min(1).max(64),
  background: ColorStringSchema.optional().describe(
    'Canvas background color. Defaults to transparent.',
  ),
  filename: z
    .string()
    .optional()
    .describe(
      'Artifact filename (without extension) saved under artifacts/renders/. ' +
        'Defaults to a timestamped name.',
    ),
  format: z.enum(['png', 'jpeg']).optional().describe('Output format. Defaults to png.'),
});
export type RenderImageRequest = z.infer<typeof RenderImageRequestSchema>;

export const RenderImageResponseSchema = z.object({
  path: z.string().describe('Project-relative path, e.g. "renders/sprite-1234.png".'),
  url: z
    .string()
    .describe('HTTP URL to the saved artifact, authed like every other artifact route.'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  base64: z.string().describe('Base64-encoded image data, ready to feed into a vision input.'),
  engine: z.enum(['playwright', 'resvg']).describe('Which render engine produced the image.'),
});
export type RenderImageResponse = z.infer<typeof RenderImageResponseSchema>;
