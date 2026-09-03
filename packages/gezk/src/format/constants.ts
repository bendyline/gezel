/** Container-level constants of the `.gezk` format. */

/**
 * Public format version. `0.x` is preliminary: breaking changes may land in
 * any minor until 1.0, and a reader supports exactly the versions it names.
 */
export const GEZK_FORMAT_VERSION = '0.5';
/** SQLite schema generation (`PRAGMA user_version` of every database). */
export const GEZK_INDEX_SCHEMA_VERSION = 2;

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

/** Fixed ZIP entry timestamp for deterministic archives. */
export const ZIP_FIXED_MTIME = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
