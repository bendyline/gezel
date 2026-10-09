# gezk JSON Schemas

One directory per format version, each generated from the `@bendyline/gezk`
Zod definitions of that line by `pnpm --filter @bendyline/gezk export-schemas`
in the gezel repository — do not edit by hand. A catalog's `manifest.json`
names its `formatVersion`; validate it against that directory. Every file's
`$id` is its address on bendyline.com, which serves the same bytes, and the
path carries the version, so a later line never overwrites the schemas that
catalogs published under an earlier one point at.

| Version | Served at |
| --- | --- |
| [`0.7/`](0.7/) | <https://bendyline.com/gezk/0.7/schemas/> |
| [`0.8/`](0.8/) | <https://bendyline.com/gezk/0.8/schemas/> |

The current line is `0.8`. An earlier directory is frozen once its line
stops being written; the specification for each lives in `spec/`.
