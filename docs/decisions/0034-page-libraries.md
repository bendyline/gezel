# 0034 — Pages load libraries from a local shelf

Status: Accepted (2026-11). Built: the desktop swap, the Gilde kind,
downloads on first use, guidance, export, modules over plain-script builds,
inline JSX and phones. It reaches people with the Gilde release that carries
the kind.
Contract: [page-libraries.md](../page-libraries.md).

## Context

A page a gezel writes runs in a sandboxed preview that reaches no other
origin below the top security level. That left pages with no libraries at
all. A bare `import 'three'` became an error module, a CDN `<script>` failed
without a word, JSX needed a React that could not load, and the kickoff told
models "no frameworks, no external assets". Models either rebuilt cameras,
charts and physics by hand, or wrote ordinary library code that broke.

Models already write libraries one way: npm names, import maps and CDN
addresses (`unpkg`, `jsdelivr`, `esm.sh`, cdnjs `three.js/r128`). They do not
know a Gezel-specific path, and small local models cannot be taught one
reliably.

## Decision

1. **A shelf of pinned libraries, loaded by their ordinary spelling.** The
   page on disk keeps the spelling the open web serves; the preview answers
   it from this computer at serve time. A page therefore still works when it
   is published, and never contacts a CDN for a library the shelf carries, at
   any security level.
2. **One address per file, and no redirects.** Every spelling of a file
   resolves to `/preview/<capability>/lib/<library>/<version>/<path>`. A
   browser keys a module by the URL it asked for, so a second address would
   run a library twice on one page.
3. **A server-made import map answers names; rewriting answers addresses.**
   Bare imports in TypeScript, plain scripts and inline modules are left as
   written and answered by one import map per page, with `scopes` so a
   line's own files import that same line. CDN addresses in tags, import maps
   and module code are rewritten. A page's own import map is merged into the
   one map, since some browsers read only the first.
4. **Bytes are never modified.** A line installs the package's own files and
   records each hash; a file is checked against its hash the first time a
   process serves it. Nothing on the shelf is scanned or rewritten, which
   keeps the pin meaningful and avoids parsing megabytes of minified code.
5. **Version lines follow what models write.** A line is one pinned release
   answering a range of requested versions, in one or both of the forms a
   page loads a library in (ES module, plain script). three.js has a current
   module line and a 0.128 line for the plain-script `r128` pattern. The
   form the page loads decides first, then the version it named, then the
   line marked default. A version the shelf lacks falls to the default with a
   console warning.
6. **The shelf route is not a preview source.** It is authorized by any live
   lease and added beside the project handler. `PreviewSourceSchema` also
   types app manifests and the mint request, so widening it would let a
   client mint leases for the shelf and change Gilde's generated schemas.
7. **Pins live in Gilde; downloads are automatic and closed.** A line is
   fetched the first time a page needs it, from the npm registry, only when
   it is pinned by hash in the bundled catalog and App network is allowed.
   Never from a preview GET: a sandboxed page must not be able to start a
   download. Store builds ship a fixed starter set and never download.
8. **The logic is a dependency-free core subpath**, `@bendyline/gezel/pages`,
   with the compiler, the scanner and the files handed in, so the desktop
   preview, the phones and DocBlocks read a page the same way.

## Alternatives

- **A Gezel-specific import path, taught in the prompt.** Costs prompt on
  every web turn, small models forget it, and the page no longer works
  outside Gezel.
- **Rewrite every import on the server, with no import map.** Needs every
  shelf file parsed and rewritten (three's addons import `three`), which
  breaks the hash pin and is slow on minified code.
- **An import map alone.** Cannot help TypeScript and JSX, whose imports the
  server resolves before the browser sees them, or plain `<script>` tags.
- **Open the CSP to a list of CDNs.** Leaves pages dependent on the network
  and on whatever version a CDN serves, and every CDN request tells a third
  party what the person is building.
- **Vendor libraries into Gilde's package.** Simple, but grows every install
  and update by the whole set, and gives no on-demand path.
- **Scan published files for their own imports at serve time.** Rejected in
  favor of declared `requires`, checked when a pin is authored: d3's
  published `.mjs` re-exports thirty packages and was caught that way.

## Consequences

- A library with no browser module is served as a module the shelf writes:
  over its plain-script build (`globals`: React 18, D3 7), or around a
  CommonJS file (`commonjs`: React 19, which publishes no browser build at
  all). The package's bytes still come from its own tarball and are never
  edited; the trust root stays the published package, and nothing had to be
  built or published by us.
- A package's example folder taken whole is large; three's addons are
  curated (no Draco, Basis or WebGPU node builds), and a phone build carries
  only the requests its line names.
- Export must carry license notices: a line records its SPDX id and notice
  file, and only permissively licensed libraries are on the shelf at first.
- Whether JavaScript that runs only inside a sandboxed page counts as
  downloaded code under store rules was not settled; store builds bundle.
