/**
 * True for managed companion/runtime paths that travel with an outside-in
 * document but are not themselves user-visible library entries.
 */
export function isOutsideInInternalPath(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some((part) => part === '_squisq' || part.toLocaleLowerCase('en-US').endsWith('_files'));
}
