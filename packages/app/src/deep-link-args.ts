import { type GezelDeepLink, parseGezelDeepLink } from '@bendyline/gezel';

/**
 * `gezel://` links from first-launch and second-instance command lines. Windows
 * and Linux hand the URL over as an argument (`"%1"` / `%U`); macOS uses
 * `open-url` instead. Only arguments that are gezel URLs survive, so a flag or
 * a `.gezmodel` path beside one is ignored here.
 */
export function findDeepLinkArguments(argv: readonly string[]): GezelDeepLink[] {
  const links: GezelDeepLink[] = [];
  for (const raw of argv) {
    const link = parseGezelDeepLink(raw.replace(/^"(.*)"$/, '$1'));
    if (link) links.push(link);
  }
  return links;
}

/** Same target, so a double click or a re-sent link opens one dialog. */
export function deepLinkKey(link: GezelDeepLink): string {
  if (link.kind === 'home') return 'home';
  if (link.kind === 'model') return `model:${link.repo}:${link.file ?? ''}`;
  return `${link.kind}:${link.id}`;
}
