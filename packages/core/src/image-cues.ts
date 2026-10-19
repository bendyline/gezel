/**
 * Image settings a person states in the message itself: "9:16", "a phone
 * wallpaper", "1920x1080", "a quick draft", "hi-res". The direct image gezel
 * reads them deterministically, applies them as settings, and takes them out
 * of the prompt, so "a lighthouse at dusk as a phone wallpaper" renders a
 * lighthouse in 9:16 rather than a lighthouse beside a phone. The composer
 * runs the same parser to show what it read before the person sends.
 *
 * Deliberately narrow. A cue must name the format, not a subject: "a
 * portrait of a woman", "a landscape painting", "a square deal" and "a 3x3
 * grid" are prompts, not settings.
 *
 * Pure and browser-safe.
 */
import {
  type ImageAspectRatio,
  ImageAspectRatioSchema,
  type ImageQuality,
  ImageQualitySchema,
} from './schemas/image.js';

export interface ImageSizeSettings {
  aspectRatio?: ImageAspectRatio;
  quality?: ImageQuality;
  width?: number;
  height?: number;
  model?: string;
}

export interface ImageSettingCue {
  /** Character range of the cue in the message, including a leading "in"/"as a". */
  start: number;
  end: number;
  /** The words as the person wrote them. */
  text: string;
  settings: ImageSizeSettings;
}

export interface ParsedImageCues {
  /** What the cues ask for; the first cue for each setting wins. */
  settings: ImageSizeSettings;
  cues: ImageSettingCue[];
  /**
   * The message with every cue taken out and the punctuation left tidy;
   * empty when the message was only settings ("make it 9:16").
   */
  prompt: string;
}

interface CueRule {
  pattern: RegExp;
  settings: (match: RegExpExecArray) => ImageSizeSettings | null;
}

const ratio = (aspectRatio: ImageAspectRatio) => () => ({ aspectRatio });
const quality = (tier: ImageQuality) => () => ({ quality: tier });

const RULES: CueRule[] = [
  {
    // Exact pixels: 1920x1080, 1024 × 1536.
    pattern: /\b(\d{3,4})\s*[x×]\s*(\d{3,4})(?:\s*(?:px|pixels))?\b/gi,
    settings: (m) => {
      const width = Number(m[1]);
      const height = Number(m[2]);
      return width >= 128 && height >= 128 ? { width, height } : null;
    },
  },
  {
    // A named ratio. Written with x only for the wide shapes nobody uses as a
    // grid size ("a 2x3 grid" is a prompt).
    pattern:
      /\b(1:1|4:5|5:4|3:4|4:3|2:3|3:2|9:16|16:9|21:9|9x16|16x9|21x9|9×16|16×9|21×9)(?:\s+(?:aspect(?:\s+ratio)?|ratio|format))?(?![\d:])/gi,
    settings: (m) => ({
      aspectRatio: m[1]!.replace(/[x×]/i, ':') as ImageAspectRatio,
    }),
  },
  {
    pattern:
      /\b(?:(?:phone|mobile|iphone|android)\s+(?:wallpaper|background|lock\s*screen)|lock\s*screen(?:\s+wallpaper)?|(?:instagram|ig)\s+stor(?:y|ies)|story\s+format|vertical\s+(?:format|orientation|image|picture)|tall\s+format|portrait\s+(?:orientation|format|mode)|in\s+portrait(?:\s+(?:orientation|format|mode))?)\b/gi,
    settings: (m) => (/portrait/i.test(m[0]) ? { aspectRatio: '4:5' } : { aspectRatio: '9:16' }),
  },
  {
    pattern:
      /\b(?:(?:desktop|laptop|computer|monitor)\s+(?:wallpaper|background)|wide\s*screen|landscape\s+(?:orientation|format|mode)|in\s+landscape(?:\s+(?:orientation|format|mode))?|horizontal\s+(?:format|orientation|image|picture)|youtube\s+thumbnail|presentation\s+slide)\b/gi,
    settings: ratio('16:9'),
  },
  {
    pattern:
      /\b(?:(?:website|web|page|header|hero|twitter|linkedin)\s+banner|banner\s+(?:image|format)|ultra\s*-?\s*wide)\b/gi,
    settings: ratio('21:9'),
  },
  {
    pattern:
      /\b(?:square\s+(?:format|image|picture|aspect|crop)|(?:instagram|ig)\s+post|profile\s+(?:picture|photo|pic))\b/gi,
    settings: ratio('1:1'),
  },
  {
    pattern: /\b(?:quick\s+draft|rough\s+draft|draft\s+quality|low[\s-]?res(?:olution)?)\b/gi,
    settings: quality('draft'),
  },
  {
    pattern:
      /\b(?:high[\s-]?res(?:olution)?|hi[\s-]?res|full\s+resolution|print\s+(?:quality|resolution)|large\s+size)\b/gi,
    settings: quality('high'),
  },
];

/** A connective that only introduces the cue: "in 9:16", "as a phone wallpaper". */
const LEADING_CONNECTIVE = /\b(?:in|as|at|for|make\s+it|made)\s+(?:an?\s+|the\s+)?$/i;
const LEADING_ARTICLE = /\b(?:an?|the)\s+$/i;
/** "a phone wallpaper of a fox": the cue stands where "an image" would. */
const TRAILING_SUBJECT = /^\s+(?:of|showing|featuring|with)\s+/i;

/** Read the image settings stated in a message. */
export function parseImageSettingsFromText(text: string): ParsedImageCues {
  const found: ImageSettingCue[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null = rule.pattern.exec(text);
    while (m) {
      const settings = rule.settings(m);
      const start = m.index;
      const end = start + m[0].length;
      if (settings && !found.some((cue) => start < cue.end && end > cue.start)) {
        const before = text.slice(0, start);
        const connective = before.match(LEADING_CONNECTIVE);
        const article = before.match(LEADING_ARTICLE);
        const subject = text.slice(end).match(TRAILING_SUBJECT);
        let from = start;
        let to = end;
        if (connective) {
          from = start - connective[0].length;
        } else if (article && subject) {
          from = start - article[0].length;
          to = end + subject[0].length;
        }
        found.push({ start: from, end: to, text: m[0], settings });
      }
      m = rule.pattern.exec(text);
    }
  }
  found.sort((a, b) => a.start - b.start);
  const settings: ImageSizeSettings = {};
  for (const cue of found) {
    for (const [key, value] of Object.entries(cue.settings) as Array<
      [keyof ImageSizeSettings, never]
    >) {
      if (settings[key] === undefined) settings[key] = value;
    }
  }
  return { settings, cues: found, prompt: removeCues(text, found) };
}

function removeCues(text: string, cues: readonly ImageSettingCue[]): string {
  if (cues.length === 0) return text;
  let out = '';
  let at = 0;
  for (const cue of [...cues, { start: text.length, end: text.length }]) {
    let piece = text.slice(at, cue.start);
    // "a 16:9 image" loses its cue but keeps its article: re-pick a or an.
    const article = out.match(/\b(an?)\s+$/i);
    const next = piece.match(/^\s*([a-z])/i);
    if (at > 0 && article && next) {
      const want = /[aeiou]/i.test(next[1]!) ? 'an' : 'a';
      out = `${out.slice(0, out.length - article[0].length)}${want} `;
      piece = piece.trimStart();
    }
    out += piece;
    at = cue.end;
  }
  const tidy = out
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.-]+/, '')
    .replace(/[\s,;:-]+$/, '')
    .trim();
  return tidy;
}

/**
 * Merge size settings from least to most specific. A layer that names a
 * shape or tier drops the exact pixels of the layers below it, and a layer
 * that names pixels drops their shape and tier, so a gezel default of
 * 1024x1024 never overrides a "9:16" the person picked.
 */
export function mergeImageSizeSettings(
  ...layers: ReadonlyArray<ImageSizeSettings | undefined>
): ImageSizeSettings {
  let merged: ImageSizeSettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    const names = layer.aspectRatio !== undefined || layer.quality !== undefined;
    const pixels = layer.width !== undefined || layer.height !== undefined;
    if (names) {
      const { width: _w, height: _h, ...rest } = merged;
      merged = rest;
    }
    if (pixels) {
      const { aspectRatio: _a, quality: _q, ...rest } = merged;
      merged = rest;
    }
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * The size settings in a loose record — a direct image gezel's stored
 * defaults — with anything of the wrong type or outside the vocabulary left
 * out, so a hand-edited default cannot fail the render.
 */
export function imageSizeSettingsFrom(
  record: Record<string, unknown> | undefined,
): ImageSizeSettings {
  if (!record) return {};
  const out: ImageSizeSettings = {};
  const positiveInt = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const width = positiveInt(record.width);
  const height = positiveInt(record.height);
  if (width) out.width = width;
  if (height) out.height = height;
  const aspect = ImageAspectRatioSchema.safeParse(record.aspectRatio);
  if (aspect.success) out.aspectRatio = aspect.data;
  const tier = ImageQualitySchema.safeParse(record.quality);
  if (tier.success) out.quality = tier.data;
  if (typeof record.model === 'string' && record.model.trim()) out.model = record.model.trim();
  return out;
}

const SIZE_KEYS = new Set(['width', 'height', 'aspectRatio', 'quality', 'model']);

/** A defaults record without its size settings, which merge separately. */
export function withoutImageSizeKeys(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !SIZE_KEYS.has(key)));
}
