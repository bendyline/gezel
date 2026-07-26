#!/usr/bin/env node
/**
 * CI/release guard: fail if `pnpm-workspace.yaml` (or the legacy `package.json`
 * location) points @bendyline/gilde at a local link. The override is the local
 * content-development flow (`pnpm link:gilde`) but breaks clean checkouts
 * because the sibling `../gilde/` checkout is not present.
 *
 * Run through `pnpm check:local-links`. Enforced in CI (or with
 * `GEZEL_ENFORCE_LOCAL_LINKS=1`); a local run only warns, so `pnpm validate`
 * stays usable while linked. See scripts/local-link-guard.mjs.
 */
import { collectLinks, reportLinks } from './local-link-guard.mjs';

process.exit(
  reportLinks({
    links: collectLinks('@bendyline/gilde'),
    subject: 'gilde',
    unlinkCommand: 'pnpm unlink:gilde',
    linkCommand: 'pnpm link:gilde',
  }),
);
