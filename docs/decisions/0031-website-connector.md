# 0031 — Websites: an offline web gezels can read without reaching it

Status: Accepted (2026-11). Builds on [0009](0009-observation-corpora.md) (corpus
layout) and [0026](0026-lookouts.md) (lookouts).
Contract: [website-connector.md](../website-connector.md).

## Context

A gezel could read the web only at Unrestricted, through tools that let a
model send requests anywhere (`fetch_url`, the Playwright browser tools). At
the default Lockdown level it could not read a web page at all, so people
pasted page text into chats by hand. A connector fits: the runtime fetches,
the gezel reads files, and there is no model-callable fetch.

## Decision

1. **A `native` connector, not a new driver.** `website` plugs into the
   existing engine, writer, scanner, quarantine, index and UI. The engine
   gained small, optional signals any adapter can use: `RecordSkippedError`,
   `PassStoppedError`, `recordWritten`, `ChangeBatch.deferred`, and
   `AdapterDeps.{capturer, trigger, signal, stateDir}`.
2. **A real browser, contained.** Pages render in the managed Chrome in a
   child process, with Chromium's sandbox on and every request through a
   daemon-owned filter proxy that resolves and pins addresses. Measured: the
   headless shell and the WebRTC command-line switch both let UDP reach the
   LAN; full Chrome with a seeded profile preference does not. Where no
   sandboxed browser runs, capture is text-only and says so.
3. **Read only, by construction.** The capturer never sends input; navigations
   are GET; walls and near-empty pages never replace a good copy.
4. **Gezels choose among found links, never supply an address.** A request
   is fetched only when it exactly matches a link the crawler found on a
   followed site, within caps; anything else is the person's to save.
5. **Sign-in is a window the person drives,** of the same contained browser,
   saved envelope-encrypted per binding, probed before every signed-in pass.
6. **Read-only connectors refresh at Lockdown.** Background sync of a type
   with no write-back actions rides `allowConnectorData`; types that can send
   keep `allowExternalServices`.

## Consequences

- A website's change log, lookouts and synopses reuse the change history,
  the lookout engine and the enrichment loop.
- The capture worker is one more emitted entry (`page-capture/capture-worker.js`)
  that must survive `npm pack`.
- Sandbox startup outside Windows must be verified on each platform before a
  release relies on screenshots there.
- Fixed in passing: a coordinator session could grant its project any stored
  credential through `PUT /api/projects/:id`; the manual sync route did not
  check the security policy.

## Rejected

- **A `curl` refresher only**: script-built pages come back empty and there
  are no screenshots. It stays as the text-only fallback.
- **Route-only request checks** (Playwright `route`): redirect hops, workers,
  WebSockets and WebRTC escape it, and a check-then-continue leaves DNS
  rebinding open.
- **An Electron window for sign-in**: a different browser from the capture
  one, no cookie partition keys or IndexedDB export, and it would end the
  app's no-remote-content rule. Kept as a fallback idea for remote daemons.
- **A model-callable fetch tool**: it dissolves the isolation connectors exist
  for (connector-standards §6).
