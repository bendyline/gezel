#!/usr/bin/env node
/**
 * CI/release guard: fail if `pnpm-workspace.yaml` (or the legacy `package.json`
 * location) has any overrides pointing squisq packages at a local link. The
 * overrides work great for local dev (you can iterate on squisq alongside
 * gezel) but break clean checkouts because the sibling `../squisq/` checkout
 * is not present.
 *
 * Run through `pnpm check:local-links`. Enforced in CI (or with
 * `GEZEL_ENFORCE_LOCAL_LINKS=1`); a local run only warns, so `pnpm validate`
 * stays usable while linked. See scripts/local-link-guard.mjs.
 */
import { collectLinks, reportLinks } from './local-link-guard.mjs';

process.exit(
  reportLinks({
    links: collectLinks('@bendyline/squisq'),
    subject: 'squisq',
    unlinkCommand: 'pnpm unlink:squisq',
    linkCommand: 'pnpm link:squisq',
  }),
);
