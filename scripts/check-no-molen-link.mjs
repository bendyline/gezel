#!/usr/bin/env node
/**
 * CI/release guard: fail if a @bendyline/molen-* package resolves to a local
 * link, either as a dependency of the service (how `pnpm link:molen` links
 * molen-stage until its first npm release) or as a `pnpm-workspace.yaml`
 * override. A link is the local development flow but breaks clean checkouts,
 * which have no sibling `../molen/` checkout.
 *
 * Run through `pnpm check:local-links`. Enforced in CI (or with
 * `GEZEL_ENFORCE_LOCAL_LINKS=1`); a local run only warns, so `pnpm validate`
 * stays usable while linked. See scripts/local-link-guard.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { collectLinks, repoRoot, reportLinks } from './local-link-guard.mjs';

const PREFIX = '@bendyline/molen-';

function serviceLinks() {
  const serviceDir = join(repoRoot, 'packages', 'service');
  const pkgPath = join(serviceDir, 'package.json');
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const declared = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.devDependencies,
  };
  return Object.entries(declared)
    .filter(([name, spec]) => name.startsWith(PREFIX) && String(spec).startsWith('link:'))
    .map(([name, spec]) => {
      // reportLinks resolves a spec from the repository root.
      const target = resolve(serviceDir, String(spec).slice('link:'.length));
      return { name, spec: `link:${relative(repoRoot, target)}` };
    });
}

process.exit(
  reportLinks({
    links: [...serviceLinks(), ...collectLinks(PREFIX)],
    subject: 'molen',
    unlinkCommand: 'pnpm unlink:molen',
    linkCommand: 'pnpm link:molen',
  }),
);
