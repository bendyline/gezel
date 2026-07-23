/**
 * CSS color parsing for render compositions. Accepts `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, and the keyword `transparent`.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export class ColorParseError extends Error {}

export function parseColor(input: string): Rgba {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (!s.startsWith('#')) {
    throw new ColorParseError(
      `Unsupported color "${input}". Use #rgb, #rgba, #rrggbb, #rrggbbaa, or "transparent".`,
    );
  }
  const hex = s.slice(1);
  const len = hex.length;
  if (!/^[0-9a-f]+$/.test(hex) || (len !== 3 && len !== 4 && len !== 6 && len !== 8)) {
    throw new ColorParseError(`Invalid hex color "${input}".`);
  }
  const expand = (h: string): number => Number.parseInt(h.length === 1 ? h + h : h, 16);
  if (len <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: len === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: expand(hex.slice(0, 2)),
    g: expand(hex.slice(2, 4)),
    b: expand(hex.slice(4, 6)),
    a: len === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
  };
}

export function toCssRgba(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}
