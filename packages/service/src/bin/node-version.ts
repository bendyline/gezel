/**
 * The oldest Node.js major `gezeld` runs on. It mirrors `engines.node` in
 * package.json (node-version.test.ts holds the two together) because npm only
 * warns about an engines mismatch: an older Node installs the package and then
 * fails inside undici with `webidl.util.markAsUncloneable is not a function`,
 * which names no version at all. The CLI keeps an identical copy in
 * packages/cli/src/bin/node-version.ts.
 *
 * Imported only by the launcher, so it must stay free of imports.
 */
export const MINIMUM_NODE_MAJOR = 24;

/** The refusal to print for a `process.versions.node` value, or undefined when it is supported. */
export function unsupportedNodeMessage(version: string): string | undefined {
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major) || major >= MINIMUM_NODE_MAJOR) return undefined;
  return (
    `Gezel needs Node.js ${MINIMUM_NODE_MAJOR} or newer (found v${version}).\n` +
    `Install Node.js ${MINIMUM_NODE_MAJOR} or later from https://nodejs.org, then run the command again.\n`
  );
}
