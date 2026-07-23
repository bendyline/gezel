/**
 * SVG sanitizer for LLM-generated icons. This is regex-based and therefore
 * inherently best-effort — the AUTHORITATIVE backstop against an injected
 * icon executing script is the renderer's Content-Security-Policy
 * (`script-src 'self'`, see packages/app/src/main.ts), which blocks inline
 * <script> and on*= handlers regardless of what slips past here. We still
 * strip the known-dangerous constructs before persisting so a non-Electron
 * embedder (or a future CSP regression) isn't left fully exposed.
 */
export function sanitizeSvg(raw: string): string {
  if (!raw) return '';
  // Extract the outer <svg>...</svg> — the LLM often wraps its output in
  // markdown fences or adds explanatory text around it.
  const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return '';
  let s = match[0];

  // Elements that can execute script or embed foreign content.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  // SMIL animation can drive an attribute (e.g. href) to a javascript:
  // URL over time; <use>/<a> can redirect to external or script refs.
  s = s.replace(/<animate\b[\s\S]*?(?:\/>|<\/animate>)/gi, '');
  s = s.replace(/<animateTransform\b[\s\S]*?(?:\/>|<\/animateTransform>)/gi, '');
  s = s.replace(/<animateMotion\b[\s\S]*?(?:\/>|<\/animateMotion>)/gi, '');
  s = s.replace(/<set\b[\s\S]*?(?:\/>|<\/set>)/gi, '');
  s = s.replace(/<\/?use\b[^>]*>/gi, '');
  // Event-handler attributes (onclick, onload, …) on any element.
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Dangerous URL schemes in href / xlink:href (keep data:image/* — see
  // the <image> rule below — but never javascript:/vbscript:).
  s = s.replace(
    /\s(?:xlink:)?href\s*=\s*("\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*'|(?:javascript|vbscript):[^\s>]*)/gi,
    '',
  );
  // <image href="..."> referencing non-data remote URLs.
  s = s.replace(
    /<image\b([^>]*?)\s(?:xlink:)?href\s*=\s*("(?!data:)[^"]*"|'(?!data:)[^']*')([^>]*)>/gi,
    '<image$1$3>',
  );

  return s.trim();
}
