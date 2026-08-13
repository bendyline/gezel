# @bendyline/gezel-connectors-spectral

Off-platform host for Apache-2.0 Prismatic components — the `spectral` driver
behind [gezel](https://github.com/bendyline/gezel)'s connectors.

```bash
npm install @bendyline/gezel-connectors-spectral
```

## What it is for

The gezel daemon **spawns** this package's `run-action` entry point as a
subprocess; it never imports it. That isolation is the point: the pinned
`@prismatic-io/spectral` SDK and the vendored components stay out of the
service process entirely.

```ts
// packages/service/src/connectors/drivers/spectral-host.ts
const entry = require.resolve('@bendyline/gezel-connectors-spectral/run-action');
```

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-connectors-spectral` | Component registry |
| `@bendyline/gezel-connectors-spectral/run-action` | The spawned action runner |

## No type declarations

This package deliberately ships no `.d.ts`. Nothing type-imports it, and
declaration emit would have to name types out of the vendored components'
transitive `axios`, which is not portable. If you need types for a connector
action, model it against the connector schemas in `@bendyline/gezel/schemas`.

## Stability

The supported surface is the `run-action` **subprocess contract** — its
argument shape and its output envelope — under semver. The CommonJS module
exports are an implementation detail of that host.

## Third-party code and licenses

The compiled entry points contain a modified, minimal slice of Prismatic's
[open-source components](https://github.com/prismatic-io/components), licensed
under Apache-2.0. The package includes:

- [`NOTICE.md`](./NOTICE.md), which identifies the upstream component and the
  modifications made for Gezel;
- [`vendor/provenance.json`](./vendor/provenance.json), the machine-readable
  per-action source, license, runtime-version, modification, and content-hash
  ledger;
- [`THIRD_PARTY_LICENSES/Apache-2.0.txt`](./THIRD_PARTY_LICENSES/Apache-2.0.txt),
  the full upstream license text.

The package as a whole remains MIT-licensed by Bendyline; those vendored
portions remain under Apache-2.0.

MIT © Bendyline
