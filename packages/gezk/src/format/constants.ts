/** Container-level constants of the `.gezk` format. */

/**
 * Public format version this implementation writes. `0.x` is preliminary:
 * breaking changes may land in any minor until 1.0, and a reader supports
 * exactly the versions it names (see {@link GEZK_FORMAT_GENERATIONS}).
 */
export const GEZK_FORMAT_VERSION = '0.6';
/** SQLite schema generation this implementation writes (`PRAGMA user_version`). */
export const GEZK_INDEX_SCHEMA_VERSION = 3;

/**
 * Every (formatVersion, indexSchemaVersion) pairing this implementation
 * reads. The writer always emits the current pair; older generations stay
 * readable so a catalog published under an earlier 0.x keeps opening after
 * a reader upgrade. A manifest that pairs the two differently is corrupt.
 */
export const GEZK_FORMAT_GENERATIONS = { '0.5': 2, '0.6': 3 } as const;
export type GezkFormatVersion = keyof typeof GEZK_FORMAT_GENERATIONS;
export type GezkIndexSchemaVersion = (typeof GEZK_FORMAT_GENERATIONS)[GezkFormatVersion];
export const GEZK_SUPPORTED_FORMAT_VERSIONS = Object.keys(GEZK_FORMAT_GENERATIONS) as [
  GezkFormatVersion,
  ...GezkFormatVersion[],
];
export const GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS = Object.values(GEZK_FORMAT_GENERATIONS) as [
  GezkIndexSchemaVersion,
  ...GezkIndexSchemaVersion[],
];

export function isSupportedFormatVersion(value: unknown): value is GezkFormatVersion {
  return typeof value === 'string' && Object.hasOwn(GEZK_FORMAT_GENERATIONS, value);
}

export function isSupportedIndexSchemaVersion(value: unknown): value is GezkIndexSchemaVersion {
  return (
    typeof value === 'number' &&
    (GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS as readonly number[]).includes(value)
  );
}

/** `PRAGMA application_id` for every database in a catalog: 'GEZK'. */
export const GEZK_APPLICATION_ID = 0x47455a4b;

/**
 * The container's media type. Stored uncompressed as the FIRST ZIP entry,
 * named `mimetype`, so the file is identifiable at a fixed byte offset (the
 * EPUB/OpenDocument convention).
 */
export const GEZK_MIME_TYPE = 'application/vnd.gezk+zip';
export const MIMETYPE_PATH = 'mimetype';
export const MANIFEST_PATH = 'manifest.json';
export const README_PATH = 'README.md';
export const LICENSE_NOTICE_PATH = 'LICENSES/catalog.txt';
export const SOURCE_NOTICES_PATH = 'LICENSES/source-notices.json';
export const ROUTER_DB_PATH = 'index/router.db';

/** Bodies below this ship uncompressed (`body_codec = 'none'`). */
export const BODY_CODEC_MIN_BYTES = 512;
/** Maximum decompressed Markdown body returned from one catalog document. */
export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 16 * 1024 * 1024;
/** Maximum canonical UTF-8 size of one document's `meta_json` object. */
export const MAX_KNOWLEDGE_DOCUMENT_META_BYTES = 16 * 1024;
/** Maximum depth of the topic forest (root = 1). */
export const MAX_KNOWLEDGE_TOPIC_DEPTH = 16;

/** Fixed ZIP entry timestamp for deterministic archives. */
export const ZIP_FIXED_MTIME = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
