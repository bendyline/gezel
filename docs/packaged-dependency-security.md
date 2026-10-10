# Packaged dependency security

The production dependency gate rejects **high and critical** advisories. The
quality, Electron release, npm publishing and daily supply-chain workflows use
the same threshold. Lower-severity advisories remain visible in the audit output.

Run `pnpm audit:vulnerabilities`, `pnpm test:audit-vulnerabilities` and
`pnpm audit:sbom` after an authorized dependency update. The service bundle builder
also checks the actual deployed dependency files, including the extracted archive
round-trip in a release build. A passing checkout audit alone does not prove that
an existing release contains the fixes: rebuild and inspect the new artifacts.

## Reviewed exceptions

`scripts/vulnerability-exceptions.json` binds each disposition to one advisory,
one package version and SHA-256 hashes of its reviewed implementation. It requires
an owner, rationale and expiry. An advisory is exempted only if every installed
copy has the expected identity and bytes. Missing, changed, mixed-version or
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
| `braces@3.0.3` | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) is resolved in the packaged payload by `patches/braces@3.0.3.patch`. Parsing and AST walkers enforce a nesting bound of 64. | 2026-11-09 |
| `sharp@0.35.3` | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) and [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) do not affect the private no-image stub. The vulnerable image libraries are absent; the existing Sharp tree verifier rejects surviving upstream payloads. | 2027-01-08 |

For braces, `scripts/braces-security.test.mjs` exercises deeply nested braces,
parentheses, mixed and unclosed groups, caller-supplied ASTs, and ordinary glob
behavior. The patch applies to the dependency itself, in addition to the tighter
product file-glob schema. Replace it with an upstream fix when available.

To revise a disposition, review the replacement implementation and advisory,
update the patch through pnpm's native patch workflow under the dependency mutation
lease, and refresh the frozen installation. Hash the actual installed runtime
files and update only the reviewed proof entries. Run the security tests, fresh
advisory gate, SBOM generation and a service bundle build. Do not extend an expiry
or refresh hashes merely to make the gate pass. Remove obsolete entries when the
corresponding dependency or workaround is removed.

## npm consumer boundary

pnpm workspace patches do not transfer into applications that install the public
npm packages. The separate clean npm-consumer audit retains its critical threshold
and does not use desktop exceptions. The braces disposition therefore applies to
the verified packaged application payload, not arbitrary npm installations.

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
