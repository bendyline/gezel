import type { PageLibraryLine } from '../schemas/page-library.js';

/**
 * What a model is told about page libraries (docs/page-libraries.md), built
 * from the lines that resolve on this host, so it names nothing a page could
 * not load. One owner for the wording, like the Squisq dialect note, so the
 * desktop, the phones and an embedding app say the same thing.
 */

export interface ListedPageLibrary {
  library: string;
  name: string;
  /** `0.187` or `18`: what a person would call the version. */
  version: string;
  /** Loaded only with a plain `<script>` tag. */
  scriptOnly: boolean;
}

function shortVersion(version: string): string {
  const [major = '0', minor = '0'] = version.split('.');
  return major === '0' ? `${major}.${minor}` : major;
}

/**
 * The libraries worth naming: each library's lines, newest first, leaving
 * out one that only exists for another to load (Chart.js's color package).
 */
export function listedPageLibraries(lines: readonly PageLibraryLine[]): ListedPageLibrary[] {
  const required = new Set(lines.flatMap((line) => Object.keys(line.requires ?? {})));
  const byLibrary = new Map<string, PageLibraryLine[]>();
  for (const line of lines)
    byLibrary.set(line.library, [...(byLibrary.get(line.library) ?? []), line]);
  const listed: ListedPageLibrary[] = [];
  for (const [library, own] of byLibrary) {
    const dependencyOnly =
      own.every((line) => line.packages.some((name) => required.has(name))) &&
      own.every((line) => !line.classic);
    if (dependencyOnly) continue;
    const sorted = [...own].sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
    for (const line of sorted) {
      listed.push({
        library,
        name: line.name,
        version: shortVersion(line.version),
        scriptOnly: !line.module,
      });
    }
  }
  return listed.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      b.version.localeCompare(a.version, undefined, { numeric: true }),
  );
}

/**
 * About 60 tokens. Plain JavaScript stays the default; a library is for when
 * it clearly helps, and anything not listed will not load without a network.
 */
export function pageLibrariesNote(lines: readonly PageLibraryLine[]): string | null {
  const listed = listedPageLibraries(lines);
  if (!listed.length) return null;
  const names: string[] = [];
  const seen = new Map<string, string[]>();
  for (const entry of listed) {
    const label = `${entry.version}${entry.scriptOnly ? ' as a script tag' : ''}`;
    if (!seen.has(entry.name)) {
      seen.set(entry.name, []);
      names.push(entry.name);
    }
    seen.get(entry.name)!.push(label);
  }
  const list = names.map((name) => `${name} ${seen.get(name)!.join(' or ')}`).join(', ');
  return `**Page libraries.** Pages you write can use these with no internet connection: ${list}. Plain JavaScript is the default; use one only when it clearly helps. Name it as usual, by package (\`import * as THREE from 'three'\`) or by its usual CDN address, and Gezel supplies it. No other library will load.`;
}
