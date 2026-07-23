#!/usr/bin/env node
/**
 * CI/release guard: fail if `pnpm-workspace.yaml` (or the legacy `package.json`
 * location) has any overrides pointing squisq packages at a local link. The
 * overrides work great for local dev (you can iterate on squisq alongside
 * gezel) but break clean checkouts because the sibling `../squisq/` checkout
 * is not present.
 *
 * Run through `pnpm check:local-links`. Local builds deliberately do not run
 * this check so linked-development workflows remain supported.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(repoRoot, 'package.json');
const workspacePath = resolve(repoRoot, 'pnpm-workspace.yaml');
if (!existsSync(pkgPath) || !existsSync(workspacePath)) process.exit(0);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const legacyOverrides = pkg?.pnpm?.overrides ?? {};
const legacyLinks = Object.entries(legacyOverrides)
  .filter(
    ([name, spec]) => name.startsWith('@bendyline/squisq') && String(spec).startsWith('link:'),
  )
  .map(([name, spec]) => `  ${name}: ${spec}`);
const workspace = readFileSync(workspacePath, 'utf8');
const workspaceLinks = [
  ...workspace.matchAll(/^\s{2}["']?(@bendyline\/squisq[^"':]*)["']?:\s*["']?(link:[^\s"']+)/gm),
].map(([, name, spec]) => `  ${name}: ${spec}`);
const squisqLinks = [...new Set([...workspaceLinks, ...legacyLinks])];

if (squisqLinks.length === 0) process.exit(0);

console.error('------------------------------------------------------------');
console.error(' Local squisq overrides cannot be used in CI or a release.');
console.error('------------------------------------------------------------');
console.error('');
console.error('These overrides only work on machines that have a sibling');
console.error('squisq checkout. Committing them breaks every CI build:');
console.error('');
for (const line of squisqLinks) console.error(line);
console.error('');
console.error('To unlink before publishing or running the CI check:');
console.error('');
console.error('  pnpm unlink:squisq');
console.error('');
console.error('Re-link locally afterwards if you want to keep iterating:');
console.error('');
console.error('  pnpm link:squisq');
process.exit(1);
