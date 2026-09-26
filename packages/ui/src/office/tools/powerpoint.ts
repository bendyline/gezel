import {
  type PaneTool,
  READ_TIMEOUT_MS,
  ToolInputError,
  WRITE_TIMEOUT_MS,
  clip,
  readInt,
  readString,
  runSerial,
  toJson,
} from './shared.js';

export interface SlideShape {
  id: string;
  name: string;
  type: string;
  text: string | null;
}

/** What the PowerPoint tools need from the presentation. Office.js below; a fake in tests. */
export interface PowerPointDeck {
  listSlides(): Promise<
    Array<{ index: number; id: string; title: string | null; shapeCount: number }>
  >;
  readSlide(index: number): Promise<{ index: number; id: string; shapes: SlideShape[] } | null>;
  insertSlide(
    title: string,
    bullets: string[],
    afterIndex?: number,
  ): Promise<{ index: number; id: string; positioned: boolean }>;
}

const TEXT_SHAPE_TYPES = new Set(['GeometricShape', 'TextBox', 'Placeholder', 'Callout']);
// 16:9 slides are 960 × 540 points.
const MARGIN = 48;
const WIDTH = 960 - 2 * MARGIN;

async function shapeTexts(
  ctx: PowerPoint.RequestContext,
  shapes: PowerPoint.Shape[],
): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const shape of shapes) {
    if (!TEXT_SHAPE_TYPES.has(String(shape.type))) {
      out.push(null);
      continue;
    }
    // One shape at a time: a shape that refuses a text frame must not sink the batch.
    try {
      const range = shape.textFrame.textRange;
      range.load('text');
      await ctx.sync();
      out.push(range.text);
    } catch {
      out.push(null);
    }
  }
  return out;
}

export function officePowerPointDeck(opts: { canMoveSlides: () => boolean }): PowerPointDeck {
  return {
    listSlides: () =>
      runSerial(() =>
        PowerPoint.run(async (ctx) => {
          const slides = ctx.presentation.slides;
          slides.load('items/id');
          await ctx.sync();
          const shapeLists = slides.items.map((slide) => {
            slide.shapes.load('items/id,items/name,items/type');
            return slide.shapes;
          });
          await ctx.sync();
          const out = [];
          for (let i = 0; i < slides.items.length; i++) {
            const shapes = shapeLists[i]!.items;
            const texts = await shapeTexts(ctx, shapes.slice(0, 3));
            out.push({
              index: i,
              id: slides.items[i]!.id,
              title:
                texts
                  .find((t) => t?.trim())
                  ?.trim()
                  .split(/\r?\n/)[0] ?? null,
              shapeCount: shapes.length,
            });
          }
          return out;
        }),
      ),
    readSlide: (index) =>
      runSerial(() =>
        PowerPoint.run(async (ctx) => {
          const slides = ctx.presentation.slides;
          slides.load('items/id');
          await ctx.sync();
          const slide = slides.items[index];
          if (!slide) return null;
          slide.shapes.load('items/id,items/name,items/type');
          await ctx.sync();
          const texts = await shapeTexts(ctx, slide.shapes.items);
          return {
            index,
            id: slide.id,
            shapes: slide.shapes.items.map((shape, i) => ({
              id: shape.id,
              name: shape.name,
              type: String(shape.type),
              text: texts[i] ?? null,
            })),
          };
        }),
      ),
    insertSlide: (title, bullets, afterIndex) =>
      runSerial(() =>
        PowerPoint.run(async (ctx) => {
          ctx.presentation.slides.add();
          await ctx.sync();
          const slides = ctx.presentation.slides;
          slides.load('items/id');
          await ctx.sync();
          const slide = slides.items[slides.items.length - 1]!;
          const heading = slide.shapes.addTextBox(title, {
            left: MARGIN,
            top: 32,
            width: WIDTH,
            height: 72,
          });
          heading.textFrame.textRange.font.size = 32;
          heading.textFrame.textRange.font.bold = true;
          if (bullets.length > 0) {
            const body = slide.shapes.addTextBox(bullets.join('\n'), {
              left: MARGIN,
              top: 124,
              width: WIDTH,
              height: 380,
            });
            body.textFrame.textRange.font.size = 20;
            body.textFrame.textRange.paragraphFormat.bulletFormat.visible = true;
          }
          let index = slides.items.length - 1;
          let positioned = afterIndex === undefined;
          const movable = slide as unknown as { moveTo?: (slideIndex: number) => void };
          if (
            afterIndex !== undefined &&
            opts.canMoveSlides() &&
            typeof movable.moveTo === 'function'
          ) {
            movable.moveTo(Math.min(afterIndex + 1, index));
            index = Math.min(afterIndex + 1, index);
            positioned = true;
          }
          await ctx.sync();
          return { index, id: slide.id, positioned };
        }),
      ),
  };
}

export function powerpointTools(deck: PowerPointDeck): PaneTool[] {
  return [
    {
      name: 'slides_list',
      description: "List the slides in the open PowerPoint presentation with each slide's title.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: READ_TIMEOUT_MS,
      requires: { set: 'PowerPointApi', version: '1.4' },
      handler: async () => {
        const slides = await deck.listSlides();
        return toJson({ count: slides.length, slides });
      },
    },
    {
      name: 'slide_read',
      description:
        'Read one slide of the open PowerPoint presentation: every shape and its text. Slides count from 0.',
      inputSchema: {
        type: 'object',
        properties: { index: { type: 'integer', minimum: 0 } },
        required: ['index'],
        additionalProperties: false,
      },
      timeoutMs: READ_TIMEOUT_MS,
      requires: { set: 'PowerPointApi', version: '1.4' },
      handler: async (args) => {
        const index = readInt(args, 'index', { min: 0, max: 10_000, fallback: 0 });
        const slide = await deck.readSlide(index);
        if (!slide)
          throw new ToolInputError(
            `There is no slide ${index}. Use slides_list to see the slides.`,
          );
        return toJson({
          ...slide,
          shapes: slide.shapes.map((s) => ({
            ...s,
            text: s.text === null ? null : clip(s.text, 8_000).text,
          })),
        });
      },
    },
    {
      name: 'slide_insert',
      description:
        'Add a slide with a title and optional bullet points to the open PowerPoint presentation. It goes after `afterIndex` when the app can move slides, otherwise at the end.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          bullets: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 12 },
          afterIndex: { type: 'integer', minimum: 0 },
        },
        required: ['title'],
        additionalProperties: false,
      },
      timeoutMs: WRITE_TIMEOUT_MS,
      write: true,
      requires: { set: 'PowerPointApi', version: '1.4' },
      handler: async (args) => {
        const title = readString(args, 'title', { required: true, max: 300 })!;
        const rawBullets = args.bullets ?? [];
        if (!Array.isArray(rawBullets) || rawBullets.some((b) => typeof b !== 'string')) {
          throw new ToolInputError('"bullets" must be a list of strings.');
        }
        if (rawBullets.length > 12) throw new ToolInputError('At most 12 bullets per slide.');
        const afterIndex =
          args.afterIndex === undefined || args.afterIndex === null
            ? undefined
            : readInt(args, 'afterIndex', { min: 0, max: 10_000, fallback: 0 });
        const result = await deck.insertSlide(title, rawBullets as string[], afterIndex);
        return toJson({ inserted: true, ...result });
      },
    },
  ];
}
