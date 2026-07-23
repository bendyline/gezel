import type { GezelDetail } from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import { sanitizeSvg } from './sanitize.js';

const ICON_REQUIREMENTS = `Requirements:
- Return ONLY the <svg>...</svg> element. No markdown fences, no prose, no explanation.
- Use viewBox="0 0 64 64"
- Flat geometric style — no gradients, no filters, no <script>, no <foreignObject>, no external references
- 2 to 4 harmonious colors
- Should be readable at 28px and also 80px

Style constraints — important:
- The icon must be ABSTRACT and SYMBOLIC. Do NOT depict humans, faces, bodies, hands, or anthropomorphic characters.
- Do NOT use role stereotypes (e.g. glasses for developers, ties for executives, lab coats for scientists, hard hats for builders). Avoid any "avatar" or mascot metaphor.
- Prefer geometric shapes, patterns, tools-of-the-trade, natural forms, or conceptual metaphors that evoke the role's essence without depicting a person.
- Think of it like a brand mark, a tarot suit, or a guild sigil — not a portrait.`;

export interface GenerateIconOptions {
  instruction?: string;
  iterateFrom?: string | null;
}

export async function generateGezelIcon(
  manager: ChatManager,
  gezel: GezelDetail,
  opts: GenerateIconOptions = {},
): Promise<string> {
  const role = gezel.role ?? 'character';
  const extra = opts.instruction?.trim();

  let prompt: string;
  if (opts.iterateFrom && opts.iterateFrom.trim().length > 0) {
    prompt = [
      `Here is the current abstract SVG icon (role: ${role}):`,
      '',
      opts.iterateFrom.trim(),
      '',
      `Modify it as follows: ${extra ?? 'refresh the design while keeping the same overall feel.'}`,
      '',
      ICON_REQUIREMENTS,
    ].join('\n');
  } else {
    const lines = [
      role === 'character'
        ? 'Create a minimalist, flat, abstract SVG icon that serves as a distinctive visual mark.'
        : `Create a minimalist, flat, abstract SVG icon that serves as a distinctive visual mark for someone whose role is "${role}". The icon should evoke the essence of that role without depicting a person.`,
    ];
    if (extra) {
      lines.push('', extra);
    }
    lines.push('', ICON_REQUIREMENTS);
    prompt = lines.join('\n');
  }

  const raw = await manager.oneShotCompletion(prompt, 120_000, {
    gezelId: gezel.id,
    jobLabel: `icon · ${gezel.name}`,
  });
  const svg = sanitizeSvg(raw);
  if (!svg) {
    throw new Error('Icon generation failed — the model did not return a valid SVG.');
  }
  return svg;
}
