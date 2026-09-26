import { isOfficeLockName, isSyncJunkName } from '../sync-junk.js';

/**
 * File-name rules the folder-inference climb uses as evidence. Deliberately
 * name-based: the climb lists directories, it never opens files.
 */

const DOCUMENT_EXTENSIONS = new Set([
  'doc',
  'docx',
  'docm',
  'dot',
  'dotx',
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'ppt',
  'pptx',
  'pptm',
  'odt',
  'ods',
  'odp',
  'odg',
  'pdf',
  'rtf',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'pages',
  'numbers',
  'key',
]);

export function isDocumentFileName(name: string): boolean {
  if (isSyncJunkName(name) || isOfficeLockName(name)) return false;
  if (name.startsWith('.')) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Directory markers that make a folder an explicit project boundary. */
const STRONG_MARKERS = new Set(['.git', '.gezel', '.hg', '.svn']);

const WEAK_MARKER_NAMES = new Set([
  'package.json',
  'project.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  '.project',
]);

/** 3 = strong boundary marker, 1 = weak project hint, 0 = not a marker. */
export function projectMarkerWeight(name: string): 0 | 1 | 3 {
  if (STRONG_MARKERS.has(name)) return 3;
  const lower = name.toLowerCase();
  if (WEAK_MARKER_NAMES.has(lower)) return 1;
  if (lower === 'readme' || lower.startsWith('readme.')) return 1;
  if (lower.endsWith('.sln') || lower.endsWith('.code-workspace')) return 1;
  return 0;
}

export function isStrongProjectMarker(name: string): boolean {
  return projectMarkerWeight(name) === 3;
}

/**
 * Folder names that usually group unrelated work rather than being one
 * piece of work: `~/work`, `Clients`, `Archive`, `2024`.
 */
const CONTAINER_NAMES = new Set([
  'projects',
  'project',
  'work',
  'clients',
  'client',
  'customers',
  'archive',
  'archives',
  'old',
  'backup',
  'backups',
  'shared',
  'inbox',
  'misc',
  'temp',
  'tmp',
  'scratch',
  'stuff',
  'files',
]);

export function isContainerFolderName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (CONTAINER_NAMES.has(lower)) return true;
  return /^\d{4}$/.test(lower) || /^\d{4}-\d{2}$/.test(lower);
}
