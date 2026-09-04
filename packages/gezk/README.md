# @bendyline/gezk

The `.gezk` knowledge-catalog **format**, as code: the manifest and registry
schemas (Zod), the id grammars, `knowledge://` references, the vector
quantization formulas, the SQLite DDL, RFC 8785 canonical JSON, and Ed25519
manifest signatures. It has no dependency on gezel — the product and the
`@bendyline/gezel-knowledge` toolchain (compiler, archive reader, retrieval)
both build on it.

```sh
npm install @bendyline/gezk
```

ESM only, Node 24+. `zod` is the sole runtime dependency.

- `@bendyline/gezk` — browser-safe: schemas, ids, URIs, quantization, DDL, JCS.
- `@bendyline/gezk/node` — everything above plus chunk ids, file digests and
  signing, which need `node:crypto` / `node:fs`.

```ts
import { KnowledgeCatalogManifestSchema, parseKnowledgeUri, quantizeInt8 } from '@bendyline/gezk';
import { verifyManifestSignature } from '@bendyline/gezk/node';

// Citations are a parsed grammar, not string surgery.
parseKnowledgeUri('knowledge://bendyline/handboek/guides/intro#line=3-9');
// → { publisherId: 'bendyline', catalogId: 'handboek', documentId: 'guides/intro',
//     fragment: { lineStart: 3, lineEnd: 9 } }

// A manifest is only ever trusted after it parses AND verifies.
const manifest = KnowledgeCatalogManifestSchema.parse(JSON.parse(rawManifestJson));
const verdict = verifyManifestSignature(manifest, trustAnchors);
if (!verdict.ok) throw new Error(`untrusted catalog: ${verdict.reason}`);

// Passage vectors are packed with these exact formulas, never a SQLite extension's.
const packed = quantizeInt8(unitVector);
```

The format specification, JSON Schemas, conformance fixtures and the Python
reference reader live in [bendyline/gezk](https://github.com/bendyline/gezk).

## License

MIT © Bendyline
