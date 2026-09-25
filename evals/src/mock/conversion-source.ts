/**
 * Which Markdown a mocked DocBlocks save should materialize.
 *
 * The file effect sits on `save_artifact`, which carries only a destination
 * and the `artifactUri` an earlier `convert_document` returned — never the
 * source. So the mock remembers each conversion: what it was asked to
 * convert (read at CALL time, as the real converter would, so a later rewrite
 * of the source does not leak into an earlier conversion) and the strings its
 * served response carried. A save is matched to its conversion through the
 * URI it cites, falling back to the latest conversion because mock URIs are
 * canned: two conversions answered from one template return the same URI,
 * and the later one is the one that URI now names.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { type SlideBreak, pptxSlideCount } from './markdown-office.ts';

/** Mock tools whose `source` argument is the document a later save materializes. */
export const MOCK_CONVERSION_TOOLS: ReadonlySet<string> = new Set(['convert_document']);

export interface MockFixtureSource {
  markdown: string;
  /** Where the Markdown came from — `workspace/<path>`, `artifacts/<path>`, or `inline markdown`. */
  origin: string;
  /** PPTX slide segmentation the conversion requested, when it named one. */
  slideBreak?: SlideBreak;
}

export interface MockConversionRecord {
  /** Null when the conversion's source could not be read as Markdown. */
  source: MockFixtureSource | null;
  /** Every string in the served response — the artifact URIs a later save cites. */
  resultStrings: ReadonlySet<string>;
  /** Slides in the PPTX this conversion produces; null without a PPTX target or a readable source. */
  slideCount: number | null;
}

export interface MockSourceContext {
  trialHome?: string;
  projectId: string | null;
}

const MARKDOWN_SOURCE_PATH = /\.(?:md|markdown|mdown|mkd|txt)$/i;
const MAX_SOURCE_BYTES = 512 * 1024;

/** Snapshot one conversion call. Never throws: an unreadable source is a null source. */
export async function recordMockConversion(
  args: unknown,
  served: unknown,
  context: MockSourceContext,
  earlier: readonly MockConversionRecord[],
): Promise<MockConversionRecord> {
  let source: MockFixtureSource | null = null;
  try {
    source = await readConversionSource(args, context, earlier);
  } catch {
    source = null;
  }
  const slideCount =
    source && requestsFormat(asRecord(args)?.targets, 'pptx')
      ? pptxSlideCount(source.markdown, { slideBreak: source.slideBreak })
      : null;
  return { source, resultStrings: stringsIn(served), slideCount };
}

/** The latest conversion whose served response carried this artifact URI. */
export function conversionForUri(
  uri: string,
  conversions: readonly MockConversionRecord[],
): MockConversionRecord | null {
  return [...conversions].reverse().find((record) => record.resultStrings.has(uri)) ?? null;
}

/** The source a save call materializes: the conversion whose URI it cites, else the latest. */
export function conversionSourceForSave(
  args: unknown,
  conversions: readonly MockConversionRecord[],
): MockFixtureSource | null {
  const uri = citedArtifactUri(args);
  const cited = uri ? conversionForUri(uri, conversions) : null;
  return (cited ?? conversions[conversions.length - 1])?.source ?? null;
}

async function readConversionSource(
  args: unknown,
  context: MockSourceContext,
  earlier: readonly MockConversionRecord[],
): Promise<MockFixtureSource | null> {
  const record = asRecord(args);
  const source = record?.source;
  const slideBreak = requestedSlideBreak(record?.targets);
  const withBreak = (resolved: MockFixtureSource | null): MockFixtureSource | null =>
    resolved && slideBreak ? { ...resolved, slideBreak } : resolved;

  if (typeof source === 'string') {
    return withBreak(await readProjectMarkdown(context, source, undefined));
  }
  const structured = asRecord(source);
  if (!structured) return null;
  if (structured.kind === 'markdown' && typeof structured.markdown === 'string') {
    return withBreak({ markdown: structured.markdown, origin: 'inline markdown' });
  }
  if (structured.kind === 'file' && typeof structured.path === 'string') {
    return withBreak(await readProjectMarkdown(context, structured.path, structured.rootId));
  }
  if (structured.kind === 'artifact' && typeof structured.uri === 'string') {
    // Re-converting an earlier conversion's output: same Markdown underneath.
    return withBreak(conversionForUri(structured.uri, earlier)?.source ?? null);
  }
  return null;
}

async function readProjectMarkdown(
  context: MockSourceContext,
  rawPath: string,
  rootId: unknown,
): Promise<MockFixtureSource | null> {
  const file = await readProjectFile(context, rawPath, rootId, {
    pattern: MARKDOWN_SOURCE_PATH,
    maxBytes: MAX_SOURCE_BYTES,
  });
  return file ? { markdown: file.bytes.toString('utf8'), origin: file.origin } : null;
}

/**
 * Read a file from the trial project's real drawers. A known root id pins
 * the drawer; an absent or unrecognized one (a model that sent the
 * placeholder instead of the `list_roots` id) tries the workspace first,
 * since DocBlocks' plain-string source is workspace-root-relative. Never
 * throws; `..` segments and anything resolving outside the drawer are null.
 */
export async function readProjectFile(
  context: MockSourceContext,
  rawPath: string,
  rootId: unknown,
  opts: { pattern: RegExp; maxBytes: number },
): Promise<{ bytes: Buffer; origin: string } | null> {
  if (!context.trialHome || !context.projectId) return null;
  const normalized = rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '');
  if (!normalized || normalized.split('/').includes('..')) return null;
  if (!opts.pattern.test(normalized)) return null;
  for (const drawer of drawersFor(rootId)) {
    const root = join(context.trialHome, 'projects', context.projectId, drawer);
    try {
      const [realRoot, realTarget] = await Promise.all([
        realpath(root),
        realpath(join(root, normalized)),
      ]);
      if (!realTarget.startsWith(`${realRoot}${sep}`)) continue;
      const info = await stat(realTarget);
      if (!info.isFile() || info.size > opts.maxBytes) continue;
      return { bytes: await readFile(realTarget), origin: `${drawer}/${normalized}` };
    } catch {
      // Missing in this drawer; try the next.
    }
  }
  return null;
}

function drawersFor(rootId: unknown): Array<'workspace' | 'artifacts'> {
  const id = typeof rootId === 'string' ? rootId.trim().toLowerCase() : '';
  if (id === 'artifacts' || id === 'artifact') return ['artifacts'];
  if (id === 'workspace') return ['workspace'];
  return ['workspace', 'artifacts'];
}

/** Whether DocBlocks `targets` (a format string, or an array of strings / `{format}` objects) asks for `format`. */
function requestsFormat(targets: unknown, format: string): boolean {
  return (Array.isArray(targets) ? targets : [targets]).some((target) => {
    const value = typeof target === 'string' ? target : asRecord(target)?.format;
    return typeof value === 'string' && value.trim().toLowerCase() === format;
  });
}

function requestedSlideBreak(targets: unknown): SlideBreak | undefined {
  for (const target of Array.isArray(targets) ? targets : [targets]) {
    const record = asRecord(target);
    if (!record || String(record.format ?? '').toLowerCase() !== 'pptx') continue;
    const value = record.slideBreak;
    if (value === 'h1' || value === 'h2' || value === 'heading') return value;
  }
  return undefined;
}

function citedArtifactUri(args: unknown): string | null {
  const record = asRecord(args);
  const candidates = [
    record?.artifactUri,
    record?.uri,
    asRecord(record?.artifact)?.uri,
    asRecord(record?.source)?.uri,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function stringsIn(value: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (depth < 8 && value && typeof value === 'object') {
    for (const child of Object.values(value)) stringsIn(child, depth + 1, out);
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
