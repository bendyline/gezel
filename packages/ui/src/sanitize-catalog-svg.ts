const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
]);

const ALLOWED_ATTRIBUTES = new Set([
  'xmlns',
  'viewbox',
  'preserveaspectratio',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'transform',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'offset',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'mask',
  'id',
  'role',
  'aria-hidden',
]);

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

/** Strictly reduce catalog-provided markup to inert, presentation-only SVG. */
export function sanitizeCatalogSvg(raw: string): string | null {
  if (raw.length === 0 || raw.length > 100_000) return null;
  const document = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const root = document.documentElement;
  if (
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    return null;
  }
  if (document.querySelector('parsererror')) return null;

  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const element of elements) {
    if (!element.isConnected || !ALLOWED_ELEMENTS.has(element.localName.toLowerCase())) {
      if (element !== root) element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.localName.toLowerCase();
      const value = attr.value;
      const unsafeUrl = /url\s*\(/i.test(value) && !/^url\(#[A-Za-z0-9_.:-]+\)$/.test(value);
      if (
        !ALLOWED_ATTRIBUTES.has(name) ||
        name.startsWith('on') ||
        name === 'href' ||
        name === 'style' ||
        value.length > 4096 ||
        hasUnsafeControlCharacter(value) ||
        unsafeUrl
      ) {
        element.removeAttributeNode(attr);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}
