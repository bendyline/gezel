# Shared table-of-contents references (gezk 0.7)

Gezk 0.7 uses index schema 4 and adds multiple TOC placements for a single
canonical document. It preserves all 0.6 body, asset, chunk, embedding, and
citation semantics. Gezel reads 0.5, 0.6, and 0.7. Older readers reject the new
version instead of silently dropping references. Published archives are never
migrated or edited in place.

## Producer API

The primary placement remains `topicPath` and `ordinal`. Additional placements
use `tocReferences`; each has a root-to-leaf path and an optional signed 32-bit
ordinal. Every path must follow the declared topic tree. Repeating a leaf,
including the primary leaf, is an error. Titles always come from the canonical
document.

```ts
{
  id: '84283796',
  title: 'Hurricane Polo',
  topicPath: ['news', '2026-09-22'],
  ordinal: 12,
  tocReferences: [
    { topicPath: ['news', '2026-09-28'], ordinal: 9 }
  ],
  // The body, source attribution, and embeddings are supplied once.
}
```

Markdown TOCs (MkDocs, GitBook, DocFX, and Jupyter Book) automatically preserve
references to the same file in multiple sections. The first placement supplies
the canonical title and primary path. Repeated links within one section collapse
to a single placement using the first position. Frontmatter subcategory shelves
apply to each placement.

## Storage and reader contract

The router adds `topic_documents(topic_id, document_id, ordinal)`, with a
composite primary key on `(topic_id, document_id)` and foreign keys to
`topics.id` and `documents.id`. It contains primary placements and additional
references. The matching primary row must have the same ordinal as the document.
An index on document ID and an index on `(topic_id, ordinal, document_id)`
support reverse lookup and scoped browsing.

The body, FTS entry, chunk rows, vectors, shard placement, and manifest
`counts.documents` remain unique per canonical document. Shard assignment uses
the primary topic path. Adding references never duplicates or re-embeds content.

- `topics.document_count` counts unique direct placements at that topic.
- Reader `totalDocumentCount` counts distinct document IDs across the subtree.
  A parent's count can be smaller than the sum of its children's counts.
- `documentsPage({ topicId })` includes references and deduplicates before
  counting, sorting, and pagination. `descendants: false` lists direct placements.
- Where several placements qualify in a subtree, choose the first by non-null
  ordinal, ordinal ascending, topic sort key, then topic ID. Order the resulting
  page by non-null ordinal, ordinal, document slug, then document ID.
- Scoped listings return the chosen placement's `topicId` and `ordinal`.
  `getDocument(id)` and unscoped listings return the primary placement.
- Search and `knowledge://` links always resolve the canonical document ID.

Validation checks reference targets, primary-placement consistency, duplicates,
ordinal types and bounds, per-topic counts, and canonical document counts.
The schema version distinguishes this table from 0.5/0.6 catalogs, whose
single-placement browse behavior remains supported.

The public specification and Python reference reader live in the separate
`bendyline/gezk` repository. This document records the 0.7 contract for that
coordinated format release; it does not claim that public release has happened.
