/**
 * Shared logic behind `pnpm check:local-links` (the squisq and gilde guards).
 *
 * `link:` overrides are the supported way to iterate on a sibling checkout, so
 * a developer machine has to stay able to run the whole `pnpm validate` gate
 * while linked. The failure this guard exists for is a *committed* link
 * reaching CI or a release, so enforcement keys on CI rather than on the
 * override merely being present. Locally we warn and continue — except when a
 * link points at a checkout that is not on disk, which would otherwise blow up
 * much later with a far worse message.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function collectLinks(prefix) {
  const pkgPath = resolve(repoRoot, 'package.json');
  const workspacePath = resolve(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(pkgPath) || !existsSync(workspacePath)) return [];

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const legacyOverrides = pkg?.pnpm?.overrides ?? {};
  const legacyLinks = Object.entries(legacyOverrides)
    .filter(([name, spec]) => name.startsWith(prefix) && String(spec).startsWith('link:'))
    .map(([name, spec]) => ({ name, spec: String(spec) }));

  const workspace = readFileSync(workspacePath, 'utf8');
  const pattern = new RegExp(
    `^\\s{2}["']?(${escapeRegExp(prefix)}[^"':]*)["']?:\\s*["']?(link:[^\\s"']+)`,
    'gm',
  );
  const workspaceLinks = [...workspace.matchAll(pattern)].map(([, name, spec]) => ({ name, spec }));

  const seen = new Set();
  return [...workspaceLinks, ...legacyLinks].filter(({ name, spec }) => {
    const key = `${name}: ${spec}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const isEnforcing = () =>
  Boolean(process.env.CI) || process.env.GEZEL_ENFORCE_LOCAL_LINKS === '1';

export function reportLinks({ links, subject, unlinkCommand, linkCommand }) {
  if (links.length === 0) return 0;

  const listed = links.map(({ name, spec }) => `  ${name}: ${spec}`);
  const missing = links.filter(
    ({ spec }) => !existsSync(resolve(repoRoot, spec.slice('link:'.length))),
  );

  if (!isEnforcing()) {
    if (missing.length > 0) {
      console.error('------------------------------------------------------------');
      console.error(` Local ${subject} override points at a missing checkout.`);
      console.error('------------------------------------------------------------');
      console.error('');
      for (const { name, spec } of missing) console.error(`  ${name}: ${spec}`);
      console.error('');
      console.error('Clone the sibling checkout, or drop the override with:');
      console.error('');
      console.error(`  ${unlinkCommand}`);
      return 1;
    }
    console.warn(`[check:local-links] using local ${subject} override:`);
    for (const line of listed) console.warn(line);
    console.warn(`[check:local-links] run \`${unlinkCommand}\` before committing or releasing.`);
    return 0;
  }

  console.error('------------------------------------------------------------');
  console.error(` Local ${subject} overrides cannot be used in CI or a release.`);
  console.error('------------------------------------------------------------');
  console.error('');
  console.error('These overrides only work on machines that have a sibling');
  console.error('checkout. Committing them breaks every CI build:');
  console.error('');
  for (const line of listed) console.error(line);
  console.error('');
  console.error('To unlink before publishing or running the CI check:');
  console.error('');
  console.error(`  ${unlinkCommand}`);
  console.error('');
  console.error('Re-link locally afterwards if you want to keep iterating:');
  console.error('');
  console.error(`  ${linkCommand}`);
  return 1;
}
