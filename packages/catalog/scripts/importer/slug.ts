/**
 * Convert upstream registry names (reverse-DNS like `io.github.foo/bar`)
 * to gezel catalog ids that conform to `IdRegex` from
 * `packages/core/src/schemas/catalog.ts`:
 *
 *   /^[a-z0-9][a-z0-9.\-:]{1,63}$/
 *
 * Strategy:
 *   1. Strip the `io.github.` prefix when present — it's the dominant
 *      bucket and adds no information once we surface the maintainer
 *      separately.
 *   2. Replace `/` with `-` (the rest of the path becomes the local
 *      part of the id).
 *   3. Lowercase and replace any character outside `[a-z0-9.\-:]` with
 *      `-`.
 *   4. Collapse runs of `-`, trim leading/trailing dashes, and ensure
 *      the first character is `[a-z0-9]`.
 *   5. Truncate to 63 chars (regex max is `{1,63}` after the first
 *      char, so total max is 64; we keep 63 to leave headroom for
 *      collision suffixes).
 *   6. Collisions get a `-2`, `-3` suffix in the order
 *      `assignSlug` is called. Persist the slug map across runs so
 *      no entry's id ever shifts after first import.
 */

const ID_REGEX = /^[a-z0-9][a-z0-9.\-:]{1,63}$/;
const VALID_CHAR_REGEX = /[a-z0-9.\-:]/;

export interface SlugAssignment {
  slug: string;
  /** True when this is the entry's first sighting and a new slug was minted. */
  fresh: boolean;
}

export class SlugAllocator {
  /** name → slug. Authoritative across runs once persisted. */
  private readonly nameToSlug = new Map<string, string>();
  /** slug → name. Reverse index for collision detection. */
  private readonly slugToName = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, slug] of Object.entries(initial)) {
      this.nameToSlug.set(name, slug);
      this.slugToName.set(slug, name);
    }
  }

  /**
   * Returns the slug for `name`, minting a new one (with collision
   * suffix if needed) on first sight. Subsequent calls return the
   * persisted slug verbatim — slugs never reshuffle.
   */
  assign(name: string): SlugAssignment {
    const existing = this.nameToSlug.get(name);
    if (existing) return { slug: existing, fresh: false };
    const base = baseSlug(name);
    let candidate = base;
    let n = 2;
    while (true) {
      const owner = this.slugToName.get(candidate);
      if (!owner || owner === name) break;
      candidate = truncate(`${base}-${n}`);
      n += 1;
      if (n > 999) {
        throw new Error(`slug collision blowup for ${name}`);
      }
    }
    this.nameToSlug.set(name, candidate);
    this.slugToName.set(candidate, name);
    return { slug: candidate, fresh: true };
  }

  /** Snapshot for persistence. Sorted for stable diffs. */
  toJSON(): Record<string, string> {
    const out: Record<string, string> = {};
    const keys = [...this.nameToSlug.keys()].sort();
    for (const key of keys) {
      out[key] = this.nameToSlug.get(key)!;
    }
    return out;
  }
}

export function baseSlug(name: string): string {
  let s = name.toLowerCase();
  // Drop the `io.github.` prefix — it's the long tail's dominant
  // bucket and adds no signal.
  if (s.startsWith('io.github.')) s = s.slice('io.github.'.length);
  // Reverse-DNS namespace separator becomes a dash.
  s = s.replace(/\//g, '-');
  // Replace any disallowed character with a dash.
  let out = '';
  for (const ch of s) {
    out += VALID_CHAR_REGEX.test(ch) ? ch : '-';
  }
  // Collapse multiple dashes.
  out = out.replace(/-+/g, '-');
  // Trim leading/trailing punctuation we shouldn't start with.
  out = out.replace(/^[.\-:]+/, '').replace(/[.\-:]+$/, '');
  if (out.length === 0) out = 'unnamed';
  // Ensure first char is `[a-z0-9]` (the regex's first-char class).
  if (!/^[a-z0-9]/.test(out)) out = `x-${out}`;
  return truncate(out);
}

function truncate(s: string): string {
  // IdRegex max is 64 total (1 first char + 63 rest). Cap at 63 so we
  // have headroom for collision suffixes without exceeding the limit.
  if (s.length <= 63) return s;
  return s.slice(0, 63).replace(/[.\-:]+$/, '');
}

export function isValidSlug(s: string): boolean {
  return ID_REGEX.test(s);
}
