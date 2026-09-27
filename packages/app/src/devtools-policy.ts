/**
 * Whether this launch may open Chromium DevTools.
 *
 * The renderer holds the daemon's bearer token, so a DevTools console in a
 * packaged build is a "paste this to fix it" target: whatever someone is
 * talked into typing there runs with the user's full API access. Development
 * launches keep DevTools. A packaged build offers them only when support
 * explicitly asks the person to relaunch with `GEZEL_DEVTOOLS=1`.
 */
export function devToolsAllowed(input: {
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (!input.isPackaged) return true;
  return input.env.GEZEL_DEVTOOLS === '1';
}
