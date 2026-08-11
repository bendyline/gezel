import type { GezelClient } from '@bendyline/gezel-client';
import { resolveOutsideInLayout } from './outside-in.js';

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'csv',
  'json',
  'yaml',
  'yml',
]);

export const DROPPABLE_DOCUMENT_EXTENSIONS = [
  ...TEXT_DOCUMENT_EXTENSIONS,
  'html',
  'htm',
  'docx',
  'pdf',
  'pptx',
  'xlsx',
] as const;

const DROPPABLE_DOCUMENT_EXTENSION_SET = new Set<string>(DROPPABLE_DOCUMENT_EXTENSIONS);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase('en-US') : '';
}

function cleanFilename(name: string): string {
  return [...name]
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === '/' || character === '\\' || code < 32 ? '-' : character;
    })
    .join('')
    .trim();
}

function joinPath(parent: string, child: string): string {
  const root = parent.replace(/^\/+|\/+$/g, '');
  return root ? `${root}/${child}` : child;
}

function splitExtension(filename: string): { stem: string; extension: string } {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return { stem: filename, extension: '' };
  return { stem: filename.slice(0, dot), extension: filename.slice(dot) };
}

function uniqueTargetPath(
  destination: string,
  filename: string,
  occupiedFoldedPaths: Set<string>,
): string {
  const { stem, extension } = splitExtension(filename);
  let candidate = joinPath(destination, filename);
  let suffix = 2;
  const collides = (path: string): boolean => {
    if (occupiedFoldedPaths.has(path.toLocaleLowerCase('en-US'))) return true;
    const layout = resolveOutsideInLayout(path);
    if (!layout) return false;
    const companion = layout.companionDirectory.toLocaleLowerCase('en-US');
    return [...occupiedFoldedPaths].some(
      (occupied) => occupied === companion || occupied.startsWith(`${companion}/`),
    );
  };
  while (collides(candidate)) {
    candidate = joinPath(destination, `${stem} ${suffix}${extension}`);
    suffix += 1;
  }
  occupiedFoldedPaths.add(candidate.toLocaleLowerCase('en-US'));
  const layout = resolveOutsideInLayout(candidate);
  if (layout) {
    occupiedFoldedPaths.add(layout.companionDirectory.toLocaleLowerCase('en-US'));
  }
  return candidate;
}

function mimeTypeFor(path: string, supplied: string): string {
  if (supplied) return supplied;
  switch (extensionOf(path)) {
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'text/markdown';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pdf':
      return 'application/pdf';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:
      return 'application/octet-stream';
  }
}

export function canDropDocumentFile(file: Pick<File, 'name'>): boolean {
  return DROPPABLE_DOCUMENT_EXTENSION_SET.has(extensionOf(file.name));
}

async function writeOutsideInImport(
  client: GezelClient,
  file: File,
  targetPath: string,
): Promise<string[]> {
  const layout = resolveOutsideInLayout(targetPath);
  if (!layout) throw new Error(`${file.name} is not a supported rendered document.`);

  // A drop adds the rendered document byte-for-byte; it does not imply
  // permission to edit via Markdown. Selecting the new file imports a
  // read-only companion for preview. The recovery copy + editable flag are
  // created only after the explicit outside-in editing opt-in.
  await client.writeDocumentBinary(layout.targetPath, file, mimeTypeFor(targetPath, file.type));
  return [];
}

export interface DroppedDocumentImportResult {
  importedPaths: string[];
  warnings: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Import OS-dropped files into the shared Documents library.
 *
 * Existing names are never overwritten: Finder/Explorer-style numeric
 * suffixes are assigned deterministically across both existing files and the
 * current batch. Rendered Office/PDF/HTML inputs use the outside-in companion
 * contract; text documents are written directly.
 */
export async function importDroppedDocumentFiles(options: {
  client: GezelClient;
  files: readonly File[];
  destination?: string;
  existingPaths: readonly string[];
}): Promise<DroppedDocumentImportResult> {
  const destination = options.destination?.replace(/^\/+|\/+$/g, '') ?? '';
  const occupied = new Set(options.existingPaths.map((path) => path.toLocaleLowerCase('en-US')));
  const result: DroppedDocumentImportResult = {
    importedPaths: [],
    warnings: [],
    rejected: [],
  };

  for (const file of options.files) {
    const filename = cleanFilename(file.name);
    if (!filename || !canDropDocumentFile({ name: filename })) {
      result.rejected.push({
        name: file.name || 'Unnamed file',
        reason: 'Unsupported document type',
      });
      continue;
    }

    const targetPath = uniqueTargetPath(destination, filename, occupied);
    try {
      if (resolveOutsideInLayout(targetPath)) {
        result.warnings.push(...(await writeOutsideInImport(options.client, file, targetPath)));
      } else if (TEXT_DOCUMENT_EXTENSIONS.has(extensionOf(filename))) {
        await options.client.writeDocument(targetPath, await file.text());
      } else {
        throw new Error('Unsupported document type');
      }
      result.importedPaths.push(targetPath);
    } catch (error) {
      result.rejected.push({
        name: file.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
