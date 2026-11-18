# 0033 — Spectral connectors run Prismatic's published components

Status: Accepted (2026-11). Replaces the vendored-slice approach in
[connectors.md](../connectors.md) ("Seeding from an external library").
Contract: [connectors.md](../connectors.md#seeding-from-an-external-library-prismatic-components).

## Context

The `spectral` driver ran a hand-vendored slice of one Prismatic component
(Airtable `listRecords`) on an SDK pinned 44 releases behind, through a
private `dist/` import. Each new component meant another vendored slice. On
2026-11-04 Prismatic began publishing every component to npm
(`@prismatic-io/components-<key>`, Apache-2.0, no dependencies, peer
`@prismatic-io/spectral`), each exporting a callable component. Of 175, 110
have polling triggers whose position is a plain object the host keeps.

## Decision

1. **Run the published package, never vendor it.** A type's manifest pins the
   component exactly: name, version, tarball and entry SHA-256, the SDK range
   it was published for, license, publish date. Only the bundled catalog may
   carry such a type.
2. **Download on connect; bundle nothing.** The component store fetches the
   pinned tarball into `~/.gezel/connector-components/` when a connection is
   made, refuses it unless every pin holds and it has no dependencies, and
   removes installs no connection has used for a day. Store builds refuse,
   since they may not download code; so does a security level that keeps
   connectors off the network.
3. **The SDK stays ours.** `@prismatic-io/spectral` is an exact-pinned
   dependency of `connectors-spectral`, under the workspace lockfile and its
   7-day hold, with no exclusions. A resolve hook serves every SDK import a
   component makes from that copy, so the HTTP stack that carries the
   credential is the one we reviewed, and refuses anything else the
   component reaches for.
4. **The sandbox boundary stays.** The service never imports the SDK or a
   component. Runner v2 runs one job per child: network on, the corpus out of
   reach, the credential over stdin, results to files. Replay runs, for
   contracts, deny the network.
5. **Two modes, both through the engine's paging.** `trigger` keeps a polling
   trigger's state as the cursor; `action` lists an action whole each pass as
   a full listing, so mirrors prune. Records stage in the binding's private
   folder, so a drain larger than a batch never re-runs the component.

## Consequences

- A new Spectral type is a manifest and a contract sidecar, drafted with
  `connectors:draft-spectral`, with no code change.
- The in-runner origin guard is defense in depth, not a boundary: the OS gives
  the child the network as a whole, and a determined component can reach
  around a JavaScript hook. The pin, the review of each version, and the
  sandbox's file confinement are what we rely on.
- OAuth token refresh for Spectral connections is not built; types use API
  keys and tokens until it is.
- The vendored Airtable slice stays until `airtable-records` 2.0.0 ships in
  gilde and the pin moves; existing 1.0.x connections then move to it.
- Downloading a package on the person's request is our reading of the license
  question, pending a legal review.
