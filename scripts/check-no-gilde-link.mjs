#!/usr/bin/env node
/**
 * CI/release guard: fail if `pnpm-workspace.yaml` (or the legacy `package.json`
 * location) points @bendyline/gilde at a local link. The override is the local
 * content-development flow (`pnpm link:gilde`) but breaks clean checkouts
 * because the sibling `../gilde/` checkout is not present.
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
  .filter(([name, spec]) => name.startsWith('@bendyline/gilde') && String(spec).startsWith('link:'))
  .map(([name, spec]) => `  ${name}: ${spec}`);
const workspace = readFileSync(workspacePath, 'utf8');
const workspaceLinks = [
  ...workspace.matchAll(/^\s{2}["']?(@bendyline\/gilde[^"':]*)["']?:\s*["']?(link:[^\s"']+)/gm),
].map(([, name, spec]) => `  ${name}: ${spec}`);
const gildeLinks = [...new Set([...workspaceLinks, ...legacyLinks])];

if (gildeLinks.length === 0) process.exit(0);

console.error('------------------------------------------------------------');
console.error(' A local gilde override cannot be used in CI or a release.');
console.error('------------------------------------------------------------');
console.error('');
console.error('This override only works on machines that have a sibling');
console.error('gilde checkout. Committing it breaks every CI build:');
console.error('');
for (const line of gildeLinks) console.error(line);
console.error('');
console.error('To unlink before publishing or running the CI check:');
console.error('');
console.error('  pnpm unlink:gilde');
console.error('');
console.error('Re-link locally afterwards if you want to keep iterating:');
console.error('');
console.error('  pnpm link:gilde');
process.exit(1);
