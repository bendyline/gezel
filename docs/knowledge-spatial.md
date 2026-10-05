# Location queries for knowledge catalogs

Gezk 0.7 (index schema 4) stores document point locations in the router.
`locations` are optional compiler inputs; `document_locations` and the
manifest `spatial` summary are present even for catalogs with no points.
The public contract lives in the [0.7 specification](../../gezk/spec/gezk-0.7.md).
The portable schemas and sphere predicate live in `packages/gezk/src/spatial.ts`;
SQLite candidate scans live in the knowledge reader and its worker host.

## Meaning and scope

Locations have stable document-local IDs, latitude/longitude in WGS84 degrees,
a `subject` or `associated` role, and optional producer provenance. Radius
queries consider only subjects. Multiple subject anchors are allowed; a
river or park anchor does not describe its entire geographic extent.

Membership uses an inclusive spherical distance with radius 6,371,000 metres,
including date-line and pole handling. Missing coordinates are unknown.
The nearest matching anchor represents a document; deduplication happens
before totals and pagination. Bounding boxes accelerate candidates and do
not decide circle membership. No new database extension or dependency is
needed. Polygon intersection and geocoding are future features.

## HTTP and client APIs

Text-free discovery:

```http
POST /api/knowledge/nearby
Content-Type: application/json

{"spatial":{"latitude":47.6062,"longitude":-122.3321,"radiusMeters":50000},"limit":50}
```

Optional `catalogs` narrows enabled catalog IDs. Empty `catalogs` means no
catalogs. The response has `documents`, deduplicated `total`, and optional
`nextCursor`. Each document includes publisher/catalog/version, citation URI,
locations, `distanceMeters`, and `matchedLocation`. Continue with the same
radius and filters. Cursors bind the query and authorized catalog
versions/digests; changed scope or snapshots return HTTP 400 and require a
fresh query. Scope is also rechecked before returning discovery results.

```typescript
await client.nearbyKnowledge({ spatial, limit: 50 });
await client.searchKnowledge({ query: 'maritime history', spatial, catalogs: ['qualla-region-pacific-northwest'] });
```

`POST /api/knowledge/search` accepts the same optional `spatial` radius.
Catalog filters and geographic eligibility apply before title FTS, passage
FTS and semantic candidate limits. Every eligible shard is searched and
noneligible vector rows are masked before stage-1 top-K. Results keep their
relevance order and include distance/anchor metadata.

## Agents and project policy

`POST /api/projects/:id/tools/knowledge-nearby` and
`client.toolKnowledgeNearby(projectId, request)` provide discovery under the
project's knowledge policy. Global first-party routes keep their existing
session-token restrictions. Policy lookup errors fail closed for radius
queries. Disabled, quarantined and unselected catalogs contribute nothing.

MCP exposes `knowledge_nearby` with the request above, plus optional `cursor`.
The existing `search` tool accepts `spatial` and `catalogs`. Radius search
uses `sources: ["knowledge"]`; path prefixes and numeric search offsets are
rejected for that form. Omitted sources are narrowed to knowledge by the
MCP adapter. Plain search retains its current behavior.

## Authored Markdown catalogs

The Markdown importer accepts typed `locations` in YAML front matter and
rejects invalid coordinates. These fields are separate from opaque metadata:

```yaml
locations:
  - id: museum
    latitude: 47.6062
    longitude: -122.3321
    role: subject
```

## Reader and offline CLI

```typescript
const page = handle.nearbyDocuments(spatial, { limit: 50, offset: 0 });
const eligible = new Set(handle.spatialMatches(spatial).keys());
handle.searchDocumentsFts('museum', 10, eligible);
handle.searchSemantic(vector, { allowedDocumentIds: eligible });
```

```sh
gezel knowledge nearby catalog.gezk --latitude 47.6062 --longitude -122.3321 --radius-meters 50000 --json
gezel knowledge search catalog.gezk 'maritime history' --latitude 47.6062 --longitude -122.3321 --radius-meters 50000
```

The Python reference exposes `nearby_documents(radius, offset=0, limit=50)`
and optional `spatial=radius` on its document, passage and semantic searches.

## Existing Qualla catalogs and next builds

The explicit `qualla-regional-meta@1` adapter reads the completed 0.6 regional
archives' `meta.coordinates.{lat,lng}`, `meta.region` and
`meta.quallaArticleIds`. It validates coordinates and supplies a subject
point. It cannot recover additional locations lost by the historical
first-coordinate writer. Arbitrary metadata in other catalogs stays opaque.

Across regional copies, Qualla source IDs (`qualla-wikipedia-<page-id>` or
`qualla-wikivoyage-<page-id>`) in `qualla-region-*` catalogs deduplicate within
one publisher. Other catalog documents keep their publisher/catalog identity.
A discovery result uses the nearest copy and a citation to that exact catalog.

Qualla spool build version 4 retains every linked article location per region,
with stable article-based IDs and coordinate provenance. Its local
`--compiler-module` option permits using the 0.7 compiler while npm packages
remain unpublished; `export-region-knowledge-parquet --exporter-module`
uses the same local module for location exports. Use a new output tree and release version; frozen
2026.10.1 archives and spools remain immutable. A builder-version change is
refused beside sealed catalogs until a new output tree or explicit replacement
is requested. Export reuse also requires the current export schema version.

Parquet export version 4 adds `document-locations.parquet`, joined to documents
by `document_id`, without copying embeddings for each point. It includes
`location_id`, double-precision coordinates, role and nullable provenance
JSON. Checksummed export reports list it; older Qualla archives can also
export the adapted location rows.

## Verification

Tests cover coordinate validation, multiple anchors, zero/world radii,
antimeridian/poles, pre-limit lexical and semantic masks, cross-region
deduplication, cursors, project policy, real HTTP/client calls, and deterministic
Parquet round trips. The signed 0.7 conformance fixture and public JSON schemas
include location data; the published 0.5 and 0.6 fixtures/schemas are unchanged.
A real 50 km Seattle query against the completed Pacific Northwest catalog
matches Qualla's canonical distance function at 174 documents.
