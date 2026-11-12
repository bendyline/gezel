# Notice for the catalog snapshot

This folder is a snapshot of Bendyline's Gilde catalog (`@bendyline/gilde`;
`provenance.json` names the release). It holds catalog entries for chat models,
image models, image LoRAs and knowledge catalogs: JSON manifests, keyword lists
and logos.

## What the MIT License covers

The MIT License in `LICENSE`, beside this notice, covers Bendyline's own
catalog data: the structure of the catalog, and the manifests, settings and
descriptions Bendyline wrote. It does not cover the entries described below.

## Entries that describe third-party content

Most entries describe something other people made: a model's weights, a LoRA,
or the text in a knowledge catalog. That content is not in this folder. Gezel
downloads it from the source the entry names, and it is licensed under the
license named in the entry's own `manifest.json` (its `license` field, and
`licenseUrl` where present), not under MIT.

Knowledge-catalog entries can also carry material taken from the text they
describe, such as topic names, keyword lists and descriptions. Those entries
are licensed under the license named in their manifest, not under MIT. For
example, in this snapshot:

- The Wikipedia and regional catalogs (`wikipedia-*`, `regional-*`) name
  CC BY-SA 4.0.
- The Microsoft technology catalogs (`microsoftdocs-*`), derived from
  Microsoft's documentation, name Creative Commons Attribution 4.0 and the MIT
  License.
- The caselaw catalogs (`caselaw-*`) name CC0 1.0 Universal.

Check an entry's `license` before you reuse the entry or the content it
describes.
