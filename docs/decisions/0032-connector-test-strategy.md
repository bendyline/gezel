# 0032 — Testing connectors without an account for each provider

Status: Accepted (2026-11). Builds on [0009](0009-observation-corpora.md) (corpus
layout) and [0031](0031-website-connector.md) (engine signals).
Contract: [connector-standards.md](../connector-standards.md) §2 and §8.

## Context

Gezel ships connectors for dozens of services, and no one holds a test account
for each of them. A November 2026 review reproduced defects that the existing
tests could not reach. A scheduler starved every project behind one failing
binding. The 1000th record in a directory overflowed its file name. The
Spectral runner could not load under the sandbox. The RSS regexes ran in
quadratic time. Catalog scripts never ran in CI. Three blind spots explain
them:

- The engine was tested one scenario at a time, so interactions (paging plus
  an expired cursor plus a throttle) went unexercised.
- The generic drivers (`mcp`, `script`, `spectral`) were tested with stubs. The
  JSON manifests and scripts in the catalog never executed under test, so a
  wrong script name failed every real sync.
- Hand-written fakes encoded the authors' assumptions about each service. A
  fake can be kinder than the real service in ways no test notices.

## Decision

1. **Model-based tests for the engine.** A seeded generator (an in-repo
   PRNG, no property-testing dependency) drives sequences of adds, edits,
   deletes, moves, throttles, transient faults and expired cursors through the
   real `syncWithAdapter` and writer, then checks convergence, no duplicates,
   containment, idempotence and loud truncation. A failure prints its seed and
   is shrunk to the shortest sequence that still fails
   (`connectors/testing/model/`). Its first run found that a mirror larger than
   one batch kept deletions made while its cursor was expired; that gap is now
   closed by `fullListing`.
2. **Every catalog connector runs in CI.** Each `script` and `mcp` type version
   carries a contract sidecar (`versions/<v>/test.json`): config, recorded or
   hand-written exchanges, and the records it must produce. The sweep
   (`catalog-contract.integration.test.ts`) binds it through the real
   `ConnectorManager`, runs the real script in the real sandbox or the mcp
   driver against an in-memory server, with no network, and compares the
   corpus. A type version without a contract fails the sweep unless it is on
   an exemption list that may only shrink. Until gilde ships sidecars,
   provisional ones live in gezel.
3. **One transport per native adapter.** Every native adapter takes its HTTP
   through `AdapterDeps.fetch`, so the same fakes, the simulator and recorded
   exchanges reach all of them. Test seams are constructor-only, and a guard
   test keeps them out of production wiring.
4. **The fake changes first.** A defect in an adapter's handling of a real
   behavior (an expiring page token, a hidden like count, a quiet server) is
   first taught to the fake, so that the test fails, and only then fixed in
   the adapter.
5. **Real services, cheaply** (planned; parts 1 to 4 are built). Recorded, scrubbed exchanges keep fakes honest
   (a fidelity check fails when a fake is kinder than the recording). A
   no-account CI lane uses local servers (IMAP, SMTP, a bare Git repository)
   and stable public sources. Two test accounts (Google, personal Microsoft)
   cover the OAuth families nightly. Each connector shows how it was last
   verified.

## Consequences

- A gilde connector release carries its contract; content and test data
  travel together and are reviewed together.
- The model tests run with a fixed seed in the unit project. A kept regression is stored as its operation list, not its seed,
  so it survives a change to the generator.
- Services nobody holds an account for are verified by recordings and
  contracts, not live, and their connector cards say so.

## Rejected

- **A property-testing library**: the generator is a hundred lines, and a
  dependency would add the release-age hold to every bump.
- **Live tests for every provider**: the accounts, quotas and token rotation
  would cost more than the defects they would catch beyond recordings.
- **Fakes generated from API descriptions**: they describe the shapes a
  service promises, not the behaviors that broke (ordering, expiry,
  throttling).
