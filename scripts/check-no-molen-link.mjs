#!/usr/bin/env node
/**
 * CI/release guard: fail if `pnpm-workspace.yaml` points a @bendyline/molen-*
 * package at a local link. The override is the local development flow
 * (`pnpm link:molen`) but breaks clean checkouts, which have no sibling
 * `../molen/` checkout.
 *
 * Run through `pnpm check:local-links`. Enforced in CI (or with
 * `GEZEL_ENFORCE_LOCAL_LINKS=1`); a local run only warns, so `pnpm validate`
 * stays usable while linked. See scripts/local-link-guard.mjs.
 */
import { collectLinks, reportLinks } from './local-link-guard.mjs';

process.exit(
  reportLinks({
    links: collectLinks('@bendyline/molen-'),
    subject: 'molen',
    unlinkCommand: 'pnpm unlink:molen',
    linkCommand: 'pnpm link:molen',
  }),
);
