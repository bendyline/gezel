# Packaged dependency security

The production dependency gate rejects **critical** advisories. The quality,
Electron release, npm publishing and daily supply-chain workflows use the same
threshold. Lower-severity advisories remain visible in the audit output. The inventory includes
the separately bundled pnpm runtime's vendored packages, which are absent from the
workspace lockfile. Its metadata alone cannot authorize a code-hash exception.

Run `pnpm audit:vulnerabilities`, `pnpm test:audit-vulnerabilities` and
`pnpm audit:sbom` after an authorized dependency update. The service bundle builder
also checks the actual deployed dependency files, including the extracted archive
round-trip in a release build. A passing checkout audit alone does not prove that
an existing release contains the fixes: rebuild and inspect the new artifacts.

## Reviewed exceptions

`scripts/vulnerability-exceptions.json` binds each disposition to one advisory,
exact package versions and SHA-256 hashes of each reviewed implementation. It requires
an owner, rationale and expiry. An advisory is exempted only if every installed
copy has the expected identity and bytes. Missing, changed, unreviewed-version or
expired evidence cannot grant an exception. The bundle build checks these proofs
again after deployment and pruning; it fails if any proof cannot be verified.

The CycloneDX SBOM includes these dispositions as vulnerability analyses (VEX),
attached to the exact affected component references, with the reviewed file hashes
and expiry embedded in its properties. A version-only scanner may
still report the original advisory; consumers need to evaluate this VEX evidence.
An exception never suppresses a different advisory against the same package.

Current dispositions:

| Package | Disposition | Review deadline |
| --- | --- | --- |
| `sharp@0.35.3` | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) and [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) do not affect the private no-image stub. The vulnerable image libraries are absent; the existing Sharp tree verifier rejects surviving upstream payloads. | 2027-01-08 |

To revise a disposition, review the replacement implementation and advisory,
update the patch through pnpm's native patch workflow under the dependency mutation
lease, and refresh the frozen installation. Hash the actual installed runtime
files and update only the reviewed proof entries. Run the security tests, fresh
advisory gate, SBOM generation and a service bundle build. Do not extend an expiry
or refresh hashes merely to make the gate pass. Remove obsolete entries when the
corresponding dependency or workaround is removed.

Each `additionalVersions` entry has its own complete file-hash map. Unknown
versions fail closed; a patched legacy version does not waive other installed
versions of the same package. The primary reviewed version must still be present.

The October 27 review also records `zod@3.25.76` (plus the independently hashed
`4.6.7` compatibility export) as resolved for
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), and
`@tiptap/core@2.27.3` as resolved for
[GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh).
Both dispositions expire on 2027-01-25. See the review below for their scope.

## npm consumer boundary

pnpm workspace patches do not transfer into applications that install the public
npm packages. The separate clean npm-consumer audit retains its critical threshold
and does not use desktop exceptions.

## F1 remediation, 2026-10-10

The source update pins Axios to `1.20.0` and the MCP SDK to `1.31.0`, removing eight
high advisory matches. The reviewed braces patch addresses the ninth. MCP error
translation accepts the upgraded SDK's formatted type errors so missing-argument
repair guidance still works, while unfamiliar messages remain unchanged.

A fresh production audit reports one verified patched-braces disposition and ten
remaining lower-severity advisories: seven moderate (`@tiptap/core`, `ip-address`,
`qs`) and three low (`dompurify`, `katex`). These remain open; this change does not
claim an advisory-free dependency graph. The already-built `1.26283.89` draft is
unchanged and requires a new signed build before F1 can be closed for release bytes.

Local verification on macOS arm64 passed:

- 750 focused tests: core error translation and glob schemas (58), MCP package
  (498), service MCP bridge (84), service relay/pool/chat/tools integration (62),
  Spectral HTTP integration (8), and security/release/SBOM contracts (40).
- Typechecks for core, service, MCP and Spectral connectors; targeted formatting,
  workflow action pins, Markdown links and module-size checks.
- A fresh high-severity production audit and an 833-component CycloneDX SBOM
  containing three VEX entries with embedded file hashes. JSON-schema validation
  passed; the local validator did not enforce the internationalized URL/email
  formats declared in the CycloneDX schema.
- A disposable macOS service deployment and runtime smoke checks, followed by
  archive creation/extraction with all 24,238 files matching and all dependency
  exception proofs passing again in the extracted tree.

This was targeted dependency and packaging verification, not the full monorepo
test matrix, cross-platform installer testing or a newly signed Electron release.

## Release 1.26300.100 remediation, 2026-10-27

The released payload had 33 distinct advisory matches: eight high, 21 moderate
and four low. The workflows' critical-only threshold let the eight high findings
pass, and it stays critical-only by design: high and lower advisories are
reviewed and remediated by hand, as below, rather than failing unrelated builds.

The following table accounts for every original advisory. A fresh checkout audit
at `--audit-level=low`, including pnpm itself and its vendored graph, reports only the two byte-verified resolved dispositions
below, with no unreviewed advisory at any reported severity. No new
non-reachability exception was used to close this set.

| Package in the release | Remediation | Advisory IDs |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | Upgrade to `1.32.2`. | [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) (high), [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) (high), [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) (moderate), [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) (moderate) |
| `body-parser` | Override to `2.4.0`. | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (high) |
| `follow-redirects` | Override to `1.16.1`. | [GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8) (high), [GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c) (high) |
| `markdown-it` | Override to `14.3.3`. | [GHSA-gfr2-rv44-r23c](https://github.com/advisories/GHSA-gfr2-rv44-r23c) (high), [GHSA-vfgh-jcmw-g37q](https://github.com/advisories/GHSA-vfgh-jcmw-g37q) (low) |
| `undici` | Upgrade workspace copy to `8.12.3`; bundle pnpm `11.28.9` with vendored `6.29.1`. Major-specific overrides also protect future 6/7/8 dependency paths. | [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) (high), [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) (moderate), [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) (moderate) |
| `zod` | Upgrade main API to `4.6.7`; backport bounded-collection admission to legacy `3.25.76` and the `4.6.7` v3 compatibility export. Exact hashes required. | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high) |
| `@tiptap/core` | Verify the existing `2.27.3` published code already contains the own-property fix; retain exact CJS/ESM/UMD hashes. | [GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh) (moderate) |
| `fast-uri` | Override to `3.1.9`. | [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) (moderate), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) (moderate), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h) (low), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) (low) |
| `hono` | Upgrade to `4.13.14`. | [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) (moderate) |
| `ip-address` | Override to `10.7.5`. | [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q) (moderate), [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc) (moderate), [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) (moderate), [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) (moderate), [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) (moderate) |
| `nodemailer` | Upgrade/override to `10.2.1`. | [GHSA-4ffr-jq9g-5ffx](https://github.com/advisories/GHSA-4ffr-jq9g-5ffx) (moderate), [GHSA-g73g-hqqh-jr95](https://github.com/advisories/GHSA-g73g-hqqh-jr95) (moderate), [GHSA-m943-m63m-w62w](https://github.com/advisories/GHSA-m943-m63m-w62w) (moderate), [GHSA-85x2-q946-cp5h](https://github.com/advisories/GHSA-85x2-q946-cp5h) (moderate), [GHSA-8c8m-p3m8-cjg8](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8) (moderate) |
| `qs` | Override to `6.16.1`. | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) (moderate), [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) (moderate), [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) (moderate) |
| `katex` | Override to `0.18.2`. | [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (low) |

### Review evidence and limits

The Undici regression runs a disposable process against a loopback server that
returns six gzip content encodings and closes an incomplete response. It catches
the fetch rejection, allows asynchronous stream errors to surface, then checks
that a normal gzip request still succeeds. The original `8.11.2` release copy
exited with an unhandled error; the installed `8.12.3` and pnpm-vendored `6.29.1` copies pass under the exact shipped Windows ARM64 Node `24.22.1`. That Node runtime itself reports the fixed built-in Undici `7.30.1`.

The Zod backport follows the admission principle of upstream
[a0ebf97](https://github.com/colinhacks/zod/commit/a0ebf97): reject an oversized
bounded collection before walking its elements or allocating per-element errors.
Tests cover sync/async parsing, CJS/ESM, v3, v4, Mini, arrays, sets, maps, exact
lengths, normal input, and a transforming check before a bound. Both installed
major versions expose legacy v3 code, so both compatibility copies are patched.
This does not claim that an unbounded schema limits input size, or that a bound
after a transform can reject before running that transform. Zod 3 APIs are
retained for third-party consumers rather than globally replaced with Zod 4.

Tiptap's exact integrity-verified `2.27.3` registry tarball defines an own
`__proto__` data property before merge lookup/assignment. Although the advisory
version range includes it, the reviewed CJS, ESM and UMD files contain the fix.
CJS and ESM regressions use JSON-origin `__proto__` and verify that event-handler
attributes are not inherited and normal class merging still works. This
disposition makes no claim about other Tiptap releases or arbitrary modified files.

The exception-policy tests reject expired proofs, missing copies, unknown
versions, changed primary or companion bytes, and unpatched nested deployments.
The SBOM preserves scoped identities such as `@tiptap/core` in its VEX references.

These are source and dependency fixes, not approval of replacement release bytes.
A replacement must be built from the reviewed lockfile and patches, pass the
fresh advisory gate and extracted service-bundle proofs, and receive the normal
platform signing, installer and Windows ARM64 smoke checks. The already-published
`1.26300.100` artifacts do not acquire these fixes retroactively. The clean public
npm consumer boundary above remains separate: workspace patches do not propagate
to third-party npm installations.

### Deployment-specific corrections

The first Windows ARM64 bundle attempt correctly failed its extracted-file
proof: hoisted deployment applied the Zod patch to one copy but left five nested
`3.25.76` copies unpatched. Packaging now scans every physical copy before
pruning. It repairs only files matching integrity-verified upstream preimage
hashes, using bytes independently matched to the reviewed installed patch.
Unknown bytes, unknown versions, expired evidence or changed sources stop the
build. Atomic file replacement preserves pnpm store hardlinks. The final loose
tree and extracted archive both undergo the unchanged full proof check.

Tiptap is compiled into the UI, so its deployment proof follows the build's
source maps to the reviewed package and compares every emitted UI asset to the
service build output (source maps may be pruned). Changed, missing or additional
assets fail. Any raw Tiptap package copy in the deployment must separately match
the reviewed file hashes. This is verified fixed code, not a non-reachability
claim or an exemption for absent Node modules.

Local verification completed on Windows ARM64: full workspace build and
typecheck; 6,410 passing core/client/MCP/service/mail/Markdown compatibility tests
(12 skipped); 31 release/SBOM contract tests; and 22 security regression/policy
tests. The SBOM contains 850 components and all four reviewed VEX dispositions,
including the two pre-existing Sharp stub findings. These counts describe this
targeted verification, not the full release validation matrix.

The fresh Windows ARM64 service archive subsequently passed extraction,
all four advisory proofs and runtime import checks. Its native signature audit
reported 21 PE files: 13 validly signed and eight pre-existing third-party
exceptions, with none unaccounted for. Repository-wide lint was blocked by
concurrent UI edits; formatting of the security files and every subsequent
canonical lint check passed. No replacement signed installer was published or
approved by this remediation.
