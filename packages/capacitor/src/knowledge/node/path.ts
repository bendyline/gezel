// POSIX paths: catalog files are always '/'-separated inside the worker.
const parts = (path: string) => {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
};
export const sep = '/';
export const isAbsolute = (path: string) => path.startsWith('/');
export const normalize = (path: string) => (isAbsolute(path) ? '/' : '') + parts(path).join('/');
export const join = (...segments: string[]) => normalize(segments.filter(Boolean).join('/'));
export function resolve(...segments: string[]): string {
  let path = '';
  for (const segment of segments) path = isAbsolute(segment) ? segment : `${path}/${segment}`;
  return normalize(isAbsolute(path) ? path : `/${path}`);
}
export function relative(from: string, to: string): string {
  const a = parts(resolve(from));
  const b = parts(resolve(to));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export const dirname = (path: string) => normalize(path).replace(/\/[^/]*$/, '') || '/';
export const basename = (path: string) => parts(path).pop() ?? '';
export default { sep, isAbsolute, normalize, join, resolve, relative, dirname, basename };
