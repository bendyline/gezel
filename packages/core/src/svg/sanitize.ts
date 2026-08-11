import { DOMParser, type Element, type Node, XMLSerializer } from '@xmldom/xmldom';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const MAX_SVG_BYTES = 100_000;
const MAX_ELEMENTS = 2_048;
const MAX_DEPTH = 32;
const MAX_ATTRIBUTE_VALUE = 4_096;

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
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'title',
  'desc',
]);

const DRAWABLE_ELEMENTS = new Set([
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
]);

const ALLOWED_ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'preserveAspectRatio',
  'color',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'clip-rule',
  'opacity',
  'transform',
  'vector-effect',
  'paint-order',
  'shape-rendering',
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

function extractSvg(raw: string): string | null {
  if (!raw || raw.length > MAX_SVG_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) return null;
  const start = raw.search(/<svg(?:\s|>)/);
  if (start < 0) return null;
  const end = raw.lastIndexOf('</svg>');
  if (end < start) return null;
  return raw.slice(start, end + '</svg>'.length);
}

function hasUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

function isSafeLocalUrl(value: string): boolean {
  return /^url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)$/.test(value.trim());
}

function attributeAllowed(element: Element, root: Element, name: string, value: string): boolean {
  if (!ALLOWED_ATTRIBUTES.has(name)) return false;
  if (value.length > MAX_ATTRIBUTE_VALUE || hasUnsafeCharacters(value)) return false;
  if (/url\s*\(/i.test(value) && !isSafeLocalUrl(value)) return false;
  if (name === 'id' && !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) return false;
  if (name === 'xmlns') {
    return element === root && value === SVG_NAMESPACE;
  }
  return true;
}

interface SanitizeState {
  elements: number;
  drawableElements: number;
  invalid: boolean;
}

function sanitizeElement(
  element: Element,
  root: Element,
  depth: number,
  state: SanitizeState,
): void {
  state.elements += 1;
  if (state.elements > MAX_ELEMENTS || depth > MAX_DEPTH) {
    state.invalid = true;
    return;
  }
  if (element.localName && DRAWABLE_ELEMENTS.has(element.localName)) state.drawableElements += 1;

  for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) continue;
    const plainAttribute = !attribute.prefix && !attribute.namespaceURI;
    const rootXmlns =
      element === root && attribute.name === 'xmlns' && attribute.namespaceURI === XMLNS_NAMESPACE;
    if (
      (!plainAttribute && !rootXmlns) ||
      attribute.name !== attribute.localName ||
      !attributeAllowed(element, root, attribute.localName, attribute.value)
    ) {
      element.removeAttributeNode(attribute);
    }
  }

  let child: Node | null = element.firstChild;
  while (child) {
    const next = child.nextSibling;
    if (child.nodeType === 1) {
      const childElement = child as Element;
      if (
        childElement.namespaceURI !== SVG_NAMESPACE ||
        !!childElement.prefix ||
        !childElement.localName ||
        !ALLOWED_ELEMENTS.has(childElement.localName)
      ) {
        element.removeChild(child);
      } else {
        sanitizeElement(childElement, root, depth + 1, state);
      }
    } else if (child.nodeType === 3) {
      const mayContainText = element.localName === 'title' || element.localName === 'desc';
      if (!mayContainText && child.nodeValue?.trim()) element.removeChild(child);
    } else {
      // Comments, CDATA, entity references, and processing instructions are
      // unnecessary for presentation and widen the parser attack surface.
      element.removeChild(child);
    }
    child = next;
  }
}

function removeBrokenLocalReferences(root: Element): void {
  const ids = new Set<string>();
  const visit = (element: Element) => {
    const id = element.getAttribute('id');
    if (id) {
      if (ids.has(id)) element.removeAttribute('id');
      else ids.add(id);
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) visit(child as Element);
    }
  };
  visit(root);

  const validate = (element: Element) => {
    for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
      const attribute = element.attributes.item(index);
      if (!attribute) continue;
      const match = /^url\(#([A-Za-z_][A-Za-z0-9_.:-]*)\)$/.exec(attribute.value.trim());
      if (match && !ids.has(match[1]!)) element.removeAttributeNode(attribute);
    }
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) validate(child as Element);
    }
  };
  validate(root);
}

/**
 * Reduce arbitrary input to a small, inert, presentation-only SVG subset.
 *
 * The allowlist deliberately excludes style, links, image/use references,
 * filters, animation, foreign content, and every event-bearing or namespaced
 * attribute. The result is suitable for persistence and transport; render it
 * as an image rather than inserting it into a live HTML DOM.
 */
export function sanitizePresentationSvg(raw: string): string | null {
  const candidate = extractSvg(raw);
  if (!candidate) return null;

  let document: ReturnType<DOMParser['parseFromString']>;
  try {
    document = new DOMParser({
      locator: false,
      onError: (_level, message) => {
        throw new Error(message);
      },
    }).parseFromString(candidate, 'image/svg+xml');
  } catch {
    return null;
  }

  const root = document.documentElement;
  if (
    !root ||
    root.localName !== 'svg' ||
    root.namespaceURI !== SVG_NAMESPACE ||
    !!root.prefix ||
    root.parentNode !== document
  ) {
    return null;
  }

  const state: SanitizeState = { elements: 0, drawableElements: 0, invalid: false };
  sanitizeElement(root, root, 0, state);
  if (state.invalid || state.drawableElements === 0) return null;
  removeBrokenLocalReferences(root);

  const serialized = new XMLSerializer().serializeToString(root);
  return serialized.length <= MAX_SVG_BYTES ? serialized : null;
}
