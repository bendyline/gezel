import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Ownership marker for a Gezel-written file that lives in a directory Gezel
 * does not own — a Codex profile in `~/.codex`, an OpenCode plugin in the
 * user's config root.
 *
 * Three header lines precede the body: a human-readable claim, the owning
 * install, and a digest of everything below them. A hand edit breaks the
 * digest and a second Gezel install carries a different owner id, so either
 * one reads back as a foreign file that must be preserved rather than
 * overwritten. Files inside GEZEL_HOME do not need this — their digest is
 * recorded in Gezel's own state instead.
 */
export interface ManagedMarker {
  build(body: string, ownerId: string): string;
  isManaged(content: string, ownerId: string): boolean;
  /**
   * Whether the file claims to be Gezel-written at all, regardless of which
   * install owns it. Separates "another Gezel home wrote this, or it was hand
   * edited" from "this is somebody else's file entirely".
   */
  isClaimed(content: string): boolean;
}

export function createManagedMarker(input: {
  /** Line-comment prefix of the target file's language, e.g. `'# '` or `'// '`. */
  commentPrefix: string;
  /** What the file is called in the header sentence, e.g. `'profile'`. */
  noun: string;
}): ManagedMarker {
  const managedHeader = `${input.commentPrefix}Managed by Gezel. Use Settings > Connected Apps to change or remove this ${input.noun}.`;
  const ownerHeader = `${input.commentPrefix}Gezel setup owner: `;
  const digestHeader = `${input.commentPrefix}Gezel ${input.noun} digest: `;

  return {
    build(body, ownerId) {
      return `${managedHeader}\n${ownerHeader}${ownerId}\n${digestHeader}${sha256(body)}\n${body}`;
    },
    isManaged(content, ownerId) {
      const lines = content.split('\n');
      if (lines[0] !== managedHeader || lines[1] !== `${ownerHeader}${ownerId}`) return false;
      const digest = lines[2]?.startsWith(digestHeader)
        ? lines[2].slice(digestHeader.length)
        : null;
      if (!digest) return false;
      return digest === sha256(lines.slice(3).join('\n'));
    },
    isClaimed(content) {
      return content.startsWith(managedHeader);
    },
  };
}

/** Identifies the Gezel install that published a managed file. */
export function setupOwnerId(home: string): string {
  return sha256(canonicalPath(home)).slice(0, 24);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
