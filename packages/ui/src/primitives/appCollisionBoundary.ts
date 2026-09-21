/** Native safe areas and desktop phone previews share the app's usable rectangle. */
export function appCollisionBoundary(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const root = document.documentElement;
  if (root.dataset.platform !== 'mobile' && root.dataset.layout !== 'mobile') return undefined;
  return document.querySelector<HTMLElement>('.app') ?? undefined;
}
