import matter from 'gray-matter';

/**
 * ─ Fence-aware markdown structure helpers ────────────────────────────
 *
 * Shared low-level machinery for markdown formats that must never be
 * fooled by code fences: the craftbook markdown codec
 * ([craftbook-md.ts](./craftbook-md.ts)) and the skill-document parser
 * ([../skills/](../skills/)). A `## ` heading or `# ` title inside a
 * fenced block (a script source, a bash example) is content, not
 * structure — every helper here honors that.
 *
 * Extracted verbatim from craftbook-md.ts so the skill
 * parser could reuse it; behavior is byte-identical for the codec.
 */

export const FENCE = /^(```+|~~~+)(.*)$/;

export interface MdSection {
  heading: string;
  body: string;
}

/**
 * Split content on `## ` headings, fence-aware: a `## ` inside a code
 * fence never starts a section. Content before the first heading is the
 * preamble.
 */
export function splitSections(lines: string[]): { preamble: string; sections: MdSection[] } {
  const sections: MdSection[] = [];
  const preamble: string[] = [];
  let current: { heading: string; body: string[] } | null = null;
  let openFence: string | null = null;

  for (const line of lines) {
    const fence = FENCE.exec(line.trim());
    if (openFence !== null) {
      // Inside a fence: only a bare marker of the same char, at least as
      // long as the opener, closes it. Everything else is fence content.
      if (
        fence &&
        fence[1]![0] === openFence[0] &&
        fence[1]!.length >= openFence.length &&
        fence[2]!.trim() === ''
      ) {
        openFence = null;
      }
    } else if (fence) {
      openFence = fence[1]!;
    } else if (/^##\s+/.test(line)) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n') });
      current = { heading: line.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join('\n') });
  return { preamble: preamble.join('\n'), sections };
}

/**
 * The first fence-aware H1 (`# <title>`) in the text: returns its line
 * index and title, or null. Bash comments inside fenced preamble blocks
 * look exactly like H1s — the fence tracking is what makes generated
 * skill preamble stripping safe.
 */
export function findFirstH1(lines: string[]): { index: number; title: string } | null {
  let openFence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line.trim());
    if (openFence !== null) {
      if (
        fence &&
        fence[1]![0] === openFence[0] &&
        fence[1]!.length >= openFence.length &&
        fence[2]!.trim() === ''
      ) {
        openFence = null;
      }
      continue;
    }
    if (fence) {
      openFence = fence[1]!;
      continue;
    }
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) return { index: i, title: h1[1]! };
  }
  return null;
}

/** The first fenced code block's body (any tag), or undefined. */
export function extractFirstFence(body: string): string | undefined {
  const lines = body.split('\n');
  let inFence = false;
  let fenceMarker = '';
  let out: string[] | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence && !inFence) {
      inFence = true;
      fenceMarker = fence[1]!;
      out = [];
      continue;
    }
    if (inFence && isFenceClose(line, fenceMarker)) {
      return out!.join('\n');
    }
    if (inFence) out!.push(line);
  }
  return undefined;
}

/**
 * Every fenced code block in `body`, in document order, with its tag
 * (lowercased) and content. Unclosed trailing fences are dropped rather
 * than guessed at.
 */
export function extractAllFences(body: string): Array<{ lang: string; code: string }> {
  const lines = body.split('\n');
  const fences: Array<{ lang: string; code: string }> = [];
  let inFence = false;
  let fenceMarker = '';
  let lang = '';
  let buf: string[] = [];
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence && !inFence) {
      inFence = true;
      fenceMarker = fence[1]!;
      lang = fence[2]!.trim().toLowerCase();
      buf = [];
      continue;
    }
    if (inFence && isFenceClose(line, fenceMarker)) {
      inFence = false;
      fences.push({ lang, code: buf.join('\n') });
      continue;
    }
    if (inFence) buf.push(line);
  }
  return fences;
}

/** True when `line` closes a fence opened with `marker` (same char, at least as long, no tag). */
export function isFenceClose(line: string, marker: string): boolean {
  const m = FENCE.exec(line.trim());
  return (
    m !== null && m[1]![0] === marker[0] && m[1]!.length >= marker.length && m[2]!.trim() === ''
  );
}

/** Parse a yaml fence body via gray-matter's engine (no extra dependency). */
export function parseYamlBlock(yamlText: string): Record<string, unknown> {
  if (yamlText.trim().length === 0) return {};
  const parsed = matter(`---\n${yamlText}\n---\n`);
  return parsed.data as Record<string, unknown>;
}

/** Stringify fields as a yaml block body via gray-matter (trailing newline included). */
export function stringifyYamlBlock(fields: Record<string, unknown>): string {
  const full = matter.stringify('', fields);
  // matter.stringify wraps as `---\n<yaml>---\n`; strip the delimiters.
  return full.replace(/^---\r?\n/, '').replace(/---\r?\n?$/, '');
}

/** A fence long enough that the source's own backtick runs can't close it early. */
export function pickFence(source: string): string {
  let longest = 2;
  for (const m of source.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(longest + 1);
}
