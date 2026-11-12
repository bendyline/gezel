import { PROJECT_ICON_SVG_MAX_CHARS } from '@bendyline/gezel';
import { sanitizePresentationSvg } from '@bendyline/gezel/svg';
import type { ChatManager } from '../chat/manager.js';

/**
 * A project's mark is one of the app's maker's marks: a small one-color line
 * drawing. The app paints a drawn mark as a silhouette in the theme's ink, so
 * anything opaque shows and color is lost. The requirements ask for exactly
 * what survives that.
 */
const MARK_REQUIREMENTS = `Requirements:
- Return ONLY the <svg>...</svg> element. No markdown fences, no prose, no explanation.
- Use viewBox="0 0 24 24". No width or height attributes.
- One color only. Draw with stroke="currentColor" and fill="none". A small solid detail may use fill="currentColor". No other colors, no gradients, no opacity.
- Line art: stroke-width about 1.7, stroke-linecap="round", stroke-linejoin="round".
- It is shown at 18 pixels. Use at most about 8 shapes. No text, no letters, no fine detail.
- No background: never draw a rectangle or circle that fills the frame.
- Keep the drawing between 2 and 22 on both axes, and use most of that space.
- Use only these elements: g, path, circle, ellipse, rect, line, polyline, polygon.
- Draw an object or a symbol. Never a person, a face or a hand.`;

/**
 * Whether a sanitized SVG is a usable mark: it must draw something, and must
 * not be so long that it is an illustration.
 */
export function sanitizeProjectIconSvg(raw: string): string | null {
  const svg = sanitizePresentationSvg(raw);
  if (!svg || svg.length > PROJECT_ICON_SVG_MAX_CHARS) return null;
  return svg;
}

/**
 * The model answered, but not with a mark that can be used. An expected
 * outcome the person can act on, so its message is theirs to read; a model
 * that could not be reached at all is a different failure.
 */
export class ProjectIconNotDrawnError extends Error {
  constructor() {
    super('The model did not return a usable icon. Try again, or change the description.');
    this.name = 'ProjectIconNotDrawnError';
  }
}

/** The model's reply with any fences and chatter around the element removed. */
function svgElementIn(reply: string): string {
  const start = reply.indexOf('<svg');
  const end = reply.lastIndexOf('</svg>');
  return start >= 0 && end > start ? reply.slice(start, end + '</svg>'.length) : reply;
}

/**
 * Ask a model to draw a project's mark from the person's description. One
 * fresh drawing per call, and nothing is saved: the person looks at it and
 * decides. The project's name is context only; the description says what to
 * draw.
 */
export async function drawProjectIcon(
  manager: ChatManager,
  project: { id: string; name: string },
  description: string,
): Promise<string> {
  const prompt = [
    'Draw a small icon that stands beside a project in a list.',
    '',
    `Project name: ${JSON.stringify(project.name)}`,
    `What to draw: ${description.trim()}`,
    '',
    MARK_REQUIREMENTS,
  ].join('\n');
  const reply = await manager.oneShotCompletion(prompt, 120_000, {
    projectId: project.id,
    jobLabel: `icon · ${project.name}`,
  });
  const svg = sanitizeProjectIconSvg(svgElementIn(reply));
  if (!svg) throw new ProjectIconNotDrawnError();
  return svg;
}
