# gezk 0.7 JSON Schemas

Generated from the `@bendyline/gezk` Zod definitions by
`pnpm --filter @bendyline/gezk export-schemas` in the gezel repository —
do not edit by hand. Refinements that JSON Schema cannot express (the
Windows reserved-name rule on versions, NFC normalization of document ids)
are enforced by conforming readers on top of these schemas.

Each file's `$id` is its address on bendyline.com, which serves the same
bytes:

<https://bendyline.com/gezk/0.7/schemas/>

The path carries the format version, so a later line never overwrites the
schemas that catalogs published under 0.7 point at.

| File | Validates |
| --- | --- |
| `catalog-manifest.schema.json` | `manifest.json` inside a `.gezk` |
| `registry-index.schema.json` | A publisher's registry `index.json` |
| `source-notices.schema.json` | `LICENSES/source-notices.json` |
| `embedding-profile.schema.json` | The `embedding` block of a manifest |
| `chunking-profile.schema.json` | The `chunking` block of a manifest |
| `catalog-document.schema.json` | One normalized document fed to a compiler |
