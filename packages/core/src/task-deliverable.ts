import { interpolateContext, taskInterpolationContext } from './craftbook-params.js';
import { stepDeliverableTarget } from './deliverable.js';
import type { ReferencedFile, ReferencedFileKind } from './schemas/referenced-file.js';
import type { Task } from './schemas/task.js';

/**
 * Which of a task's files is THE deliverable — the thing the person asked
 * for, as opposed to everything the task made on the way to it.
 *
 * A PowerPoint run leaves `sources.md`, `outline.md`, `deck.md`, `review.md`,
 * a `deck.pptx` in the artifacts drawer and a copy of it in the workspace.
 * Listing them newest-write-first put the deck fifth, under "…and 3 more",
 * while the task's closing card previewed the outline. The owner had to read
 * a task note to find the file they wanted.
 *
 * No schema field names the deliverable, but the book's own gate machinery
 * already does: each step's `advanceWhen` / gate names the file that proves
 * the step done, and those files are the book's promises in the order it
 * makes them. The answer is the most finished-looking of those, preferring
 * later steps; files the task's sessions wrote are the fallback for books
 * (and ad-hoc tasks) whose steps name nothing. Pure — the caller decides
 * which candidates exist.
 */

/** Formats a person opens as the finished thing. */
const FINISHED_EXTENSIONS: ReadonlySet<string> = new Set([
  'pptx',
  'ppt',
  'key',
  'odp',
  'docx',
  'doc',
  'odt',
  'rtf',
  'pages',
  'pdf',
  'epub',
  'xlsx',
  'xls',
  'ods',
  'numbers',
  'html',
  'htm',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'zip',
]);

/** Prose and tables — a finished report as often as a working file. */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'csv',
  'tsv',
]);

/**
 * Source and config. A code task's product is the change, not a file, so
 * these never headline — a card offering `src/cart.ts` as "the result" of a
 * bug fix points the reader at the wrong thing.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'cs',
  'c',
  'h',
  'cpp',
  'hpp',
  'swift',
  'php',
  'sh',
  'ps1',
  'bat',
  'css',
  'scss',
  'less',
  'sql',
  'toml',
  'ini',
  'lock',
  'env',
]);

/**
 * File stems craftbooks use for their working papers. A `review.md` gated by
 * a book's last step is still the review of the deliverable, not the
 * deliverable.
 */
const WORKING_STEMS: ReadonlySet<string> = new Set([
  'sources',
  'source',
  'outline',
  'review',
  'notes',
  'plan',
  'scope',
  'verdict',
  'batches',
  'checklist',
  'progress',
  'research',
  'todo',
  'log',
  'manifest',
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * How strongly a path reads as a finished product. Zero means never a
 * deliverable: code, config, extensionless names, and working papers.
 */
export function deliverableScore(path: string): number {
  const ext = extensionOf(path);
  if (!ext || CODE_EXTENSIONS.has(ext)) return 0;
  const base = FINISHED_EXTENSIONS.has(ext) ? 3 : PROSE_EXTENSIONS.has(ext) ? 2 : 1;
  return Math.max(0, WORKING_STEMS.has(stemOf(path)) ? base - 2 : base);
}

/** A file's format in words a person uses — "PowerPoint deck", not "pptx". */
export function deliverableFormatLabel(path: string): string {
  switch (extensionOf(path)) {
    case 'pptx':
    case 'ppt':
      return 'PowerPoint deck';
    case 'key':
      return 'Keynote deck';
    case 'odp':
      return 'Presentation';
    case 'docx':
    case 'doc':
      return 'Word document';
    case 'odt':
    case 'rtf':
    case 'pages':
      return 'Document';
    case 'xlsx':
    case 'xls':
      return 'Excel workbook';
    case 'ods':
    case 'numbers':
      return 'Spreadsheet';
    case 'pdf':
      return 'PDF';
    case 'epub':
      return 'E-book';
    case 'html':
    case 'htm':
      return 'Web page';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
      return 'Image';
    case 'mp4':
    case 'webm':
    case 'mov':
    case 'm4v':
      return 'Video';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'm4a':
    case 'flac':
      return 'Audio';
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'Document';
    case 'txt':
      return 'Text';
    case 'csv':
    case 'tsv':
      return 'Table';
    case 'zip':
      return 'Archive';
    default:
      return 'File';
  }
}

/**
 * {@link deliverableFormatLabel} for the middle of a sentence: "your
 * PowerPoint deck" keeps its product name, "your web page" does not.
 */
export function deliverableFormatNoun(path: string): string {
  const label = deliverableFormatLabel(path);
  return /^(PowerPoint|Keynote|Word|Excel|PDF)\b/.test(label) ? label : label.toLowerCase();
}

function canonicalPath(raw: string, kind: ReferencedFileKind): string {
  let path = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '');
  if (kind === 'artifact') {
    while (/^artifacts\/+/i.test(path)) path = path.replace(/^artifacts\/+/i, '');
  }
  return path;
}

/**
 * Every plausible deliverable for `task`, best first. `outputs` are the files
 * its sessions wrote, newest first — the fallback for steps that name no file.
 */
export function taskDeliverableCandidates(
  task: Task,
  outputs: readonly ReferencedFile[] = [],
): ReferencedFile[] {
  const ranked: Array<{ file: ReferencedFile; score: number; order: number }> = [];
  const context = taskInterpolationContext(task);
  task.craftbook.steps.forEach((step, index) => {
    const target = stepDeliverableTarget(step);
    if (!target) return;
    const raw = target.path.includes('{{') ? interpolateContext(target.path, context) : target.path;
    if (raw.includes('{{')) return;
    const kind: ReferencedFileKind = target.artifact ? 'artifact' : 'workspace';
    const path = canonicalPath(raw, kind);
    const score = deliverableScore(path);
    // The book promised these, so they outrank a same-format file a session
    // merely wrote; a later step outranks an earlier one at equal score.
    if (path && score > 0) ranked.push({ file: { kind, path }, score: score + 0.5, order: index });
  });
  outputs.forEach((file, index) => {
    const path = canonicalPath(file.path, file.kind);
    const score = deliverableScore(path);
    if (path && score > 0) ranked.push({ file: { kind: file.kind, path }, score, order: -index });
  });
  ranked.sort((a, b) => b.score - a.score || b.order - a.order);
  const seen = new Set<string>();
  const out: ReferencedFile[] = [];
  for (const { file } of ranked) {
    const key = `${file.kind}:${file.path.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/** `outputs` reordered so `deliverable` leads, when it is among them or not. */
export function outputsWithDeliverableFirst(
  outputs: readonly ReferencedFile[],
  deliverable: ReferencedFile | null | undefined,
): ReferencedFile[] {
  if (!deliverable) return [...outputs];
  const same = (f: ReferencedFile) =>
    f.kind === deliverable.kind && f.path.toLowerCase() === deliverable.path.toLowerCase();
  return [{ kind: deliverable.kind, path: deliverable.path }, ...outputs.filter((f) => !same(f))];
}
