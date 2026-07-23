/**
 * Source adapters — the "mirror-then-index" generalization (Phase 6).
 *
 * squisq document conversion (Phase 2) was the first instance of a pattern:
 * take some external source, materialize it as markdown + frontmatter into a
 * mirror folder, and let the existing content indexer pick it up "for free".
 * An adapter is anything that turns one external item into a `MaterializedDoc`;
 * email is the first non-document adapter. The index never learns about email —
 * it only ever sees markdown.
 */

export interface MaterializedDoc {
  /** Path within the mirror, WITHOUT extension (`.md` is appended on write). */
  relPath: string;
  /** Structured fields emitted as YAML frontmatter (from/to/date/subject/…). */
  frontmatter: Record<string, string>;
  /** The body as markdown. */
  markdown: string;
}

export interface SourceAdapter {
  /** Stable adapter id (e.g. `mail`). */
  readonly kind: string;
  /** Whether this adapter handles the given source path. */
  matches(path: string): boolean;
  /** Convert one source file into a materialized markdown doc, or null to skip. */
  convert(absPath: string): Promise<MaterializedDoc | null>;
}
