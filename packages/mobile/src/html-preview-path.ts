/** Resolve only files below the selected document's directory. */
export function previewEntryPath(path: string): string {
  if (
    !path ||
    path.length > 1000 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid preview path');
  return path.endsWith('/') ? `${path}index.html` : path;
}
export function previewAssetPath(reference: string, relativeTo: string, entry: string): string {
  if (
    !reference ||
    reference.startsWith('/') ||
    reference.includes('\\') ||
    /^[a-z][a-z\d+.-]*:/i.test(reference)
  )
    throw new Error('Only local relative preview assets are supported');
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]!);
  } catch {
    throw new Error('Invalid encoded preview asset path');
  }
  if (!decoded || decoded.includes('%') || decoded.includes('\\') || decoded.startsWith('/'))
    throw new Error('Invalid preview asset path');
  const parts = relativeTo.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Preview asset escapes its folder');
      parts.pop();
    } else parts.push(part);
  }
  const path = previewEntryPath(parts.join('/'));
  const scope = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  if (!path.startsWith(scope)) throw new Error('Preview asset escapes its folder');
  return path;
}
