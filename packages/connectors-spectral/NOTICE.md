# Third-party notices

This file is informational and does not modify the licenses that apply to this
package.

## Prismatic components

The compiled `dist/index.js` and `dist/run-action.js` files include modified
portions of the open-source
[Prismatic components](https://github.com/prismatic-io/components) project,
which Prismatic distributes under the Apache License, Version 2.0. A copy of
that license is included at `THIRD_PARTY_LICENSES/Apache-2.0.txt`.

Gezel currently includes this component slice:

| Component/action | Upstream source | License |
|---|---|---|
| Airtable `listRecords` | [`components/airtable`](https://github.com/prismatic-io/components/tree/main/components/airtable) | Apache-2.0 |

Bendyline changed the upstream source by selecting only the files and symbols
needed by `listRecords`, repointing imports for off-platform execution, inlining
the required input definitions, removing documentation-only material, and
bundling the result into this package's CommonJS entry points.

The machine-readable `vendor/provenance.json` shipped with this package records
the exact included source slice, pinned `@prismatic-io/spectral` runtime,
modification summary, and a content hash over the vendored files. The readable
source files in the Gezel repository also carry per-file provenance and change
notices.

The upstream repository does not currently distribute a `NOTICE` file of its
own. Prismatic names and trademarks are used only to describe the origin of the
code and are not an endorsement of Gezel or Bendyline's modifications.
