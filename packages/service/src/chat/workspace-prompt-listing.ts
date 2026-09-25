import { type ProjectFileEntry, resolveRoleId } from '@bendyline/gezel';

/**
 * The workspace inventory is orientation, not a substitute for search. Keep
 * it small enough to establish where a specialist's material lives without
 * turning every turn into a repository dump.
 */
export const WORKSPACE_PROMPT_ENTRY_CAP = 100;

export type WorkspacePromptProfile = 'none' | 'code' | 'writing' | 'research' | 'design' | 'review';

const CLUTTER_DIRECTORY_NAMES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  '.venv',
  'venv',
]);

const BINARY_EXTENSIONS = new Set([
  // Images (SVG is deliberately absent: it is editable text).
  'avif',
  'bmp',
  'gif',
  'heic',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'psd',
  'tif',
  'tiff',
  'webp',
  // Office documents and PDFs are discoverable through indexed search and
  // document-intelligence tools; listing their filenames on every turn is
  // not worth the standing prompt cost.
  'doc',
  'docx',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'xls',
  'xlsb',
  'xlsm',
  'xlsx',
  // Archives, compiled output, databases, fonts, and media.
  '7z',
  'a',
  'apk',
  'avi',
  'bin',
  'class',
  'db',
  'dmg',
  'dll',
  'dylib',
  'eot',
  'exe',
  'flac',
  'gz',
  'jar',
  'm4a',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'o',
  'ogg',
  'otf',
  'rar',
  'so',
  'sqlite',
  'sqlite3',
  'tar',
  'tgz',
  'ttf',
  'wav',
  'wasm',
  'webm',
  'woff',
  'woff2',
  'xz',
  'zip',
]);

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
]);

const CODE_ONLY_MANIFEST_NAMES = new Set([
  'deno.json',
  'deno.jsonc',
  'package.json',
  'tsconfig.json',
]);

const CODE_EXTENSIONS = new Set([
  'astro',
  'bash',
  'c',
  'cc',
  'clj',
  'cljs',
  'cmake',
  'cpp',
  'cs',
  'css',
  'cxx',
  'dart',
  'env',
  'ex',
  'exs',
  'fish',
  'fs',
  'fsx',
  'go',
  'gql',
  'gradle',
  'graphql',
  'groovy',
  'h',
  'hcl',
  'hh',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'lua',
  'm',
  'mm',
  'mjs',
  'mts',
  'nix',
  'php',
  'pl',
  'prisma',
  'properties',
  'proto',
  'ps1',
  'py',
  'pyi',
  'pyx',
  'r',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sol',
  'sql',
  'svelte',
  'swift',
  'tf',
  'toml',
  'ts',
  'tsx',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zig',
  'zsh',
]);

const WRITING_EXTENSIONS = new Set([
  'adoc',
  'asciidoc',
  'bib',
  'md',
  'mdx',
  'org',
  'rst',
  'tex',
  'textile',
  'txt',
]);

const RESEARCH_EXTENSIONS = new Set([
  ...WRITING_EXTENSIONS,
  'csv',
  'htm',
  'html',
  'json',
  'jsonl',
  'ndjson',
  'tsv',
  'xml',
  'yaml',
  'yml',
]);

const DESIGN_EXTENSIONS = new Set([
  'css',
  'drawio',
  'excalidraw',
  'htm',
  'html',
  'json',
  'jsonc',
  'less',
  'md',
  'mdx',
  'sass',
  'scss',
  'styl',
  'svg',
  'xml',
  'yaml',
  'yml',
]);

const CODE_ORIENTATION_NAMES =
  /^(agents\.md|claude\.md|contributing\.md|dockerfile(?:\..+)?|justfile|makefile(?:\..+)?|readme(?:\..+)?)$/i;
const WRITING_ORIENTATION_NAMES = /^(brief|changelog|contributing|license|readme)(?:\..+)?$/i;

/**
 * Only specialist roles receive a standing workspace inventory. Coordinators,
 * generalists, generators, and unknown/custom roles discover paths on demand
 * with search/listing tools instead of paying for an unfocused dump every
 * turn.
 */
export function workspacePromptProfileForRole(role: string | undefined): WorkspacePromptProfile {
  switch (resolveRoleId(role)) {
    case 'developer':
    case 'web-developer':
      return 'code';
    case 'copywriter':
      return 'writing';
    case 'researcher':
      return 'research';
    case 'designer':
      return 'design';
    case 'reviewer':
      return 'review';
    default:
      return 'none';
  }
}

export function roleGetsWorkspaceOrientation(role: string | undefined): boolean {
  return workspacePromptProfileForRole(role) !== 'none';
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

function isPromptClutter(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => CLUTTER_DIRECTORY_NAMES.has(segment))) return true;

  const basename = lowerSegments.at(-1) ?? '';
  if (LOCKFILE_NAMES.has(basename)) return true;
  if (/\.(?:min\.(?:css|js)|map)$/i.test(basename)) return true;
  return BINARY_EXTENSIONS.has(extensionOf(basename));
}

function matchesProfile(path: string, profile: Exclude<WorkspacePromptProfile, 'none'>): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const extension = extensionOf(basename);
  if (
    profile !== 'code' &&
    profile !== 'review' &&
    CODE_ONLY_MANIFEST_NAMES.has(basename.toLowerCase())
  ) {
    return false;
  }
  const isCode = CODE_EXTENSIONS.has(extension) || CODE_ORIENTATION_NAMES.test(basename);
  const isWriting = WRITING_EXTENSIONS.has(extension) || WRITING_ORIENTATION_NAMES.test(basename);
  const isResearch = RESEARCH_EXTENSIONS.has(extension) || isWriting;
  const isDesign = DESIGN_EXTENSIONS.has(extension);

  switch (profile) {
    case 'code':
      return isCode;
    case 'writing':
      return isWriting;
    case 'research':
      return isResearch;
    case 'design':
      return isDesign;
    case 'review':
      return isCode || isWriting || isResearch || isDesign;
  }
}

function parentPaths(path: string): string[] {
  const segments = path.replace(/\\/g, '/').split('/');
  const parents: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    parents.push(segments.slice(0, i).join('/'));
  }
  return parents;
}

/**
 * Produce the role-scoped prompt inventory while preserving the walker's
 * breadth-first ordering. Directory rows survive only when they lead to a
 * retained file, so an excluded subtree cannot consume prompt space merely
 * by existing.
 */
export function filterWorkspaceFilesForPrompt(
  entries: readonly (ProjectFileEntry | string)[],
  role: string | undefined,
): ProjectFileEntry[] {
  const profile = workspacePromptProfileForRole(role);
  if (profile === 'none') return [];

  // A few embedders and older tests still supply the pre-ProjectFileEntry
  // string shape. Normalize it here so prompt construction remains tolerant
  // while the typed service path continues to provide detailed entries.
  const normalizedEntries = entries.map((entry): ProjectFileEntry => {
    if (typeof entry !== 'string') return entry;
    const path = entry.replace(/\\/g, '/');
    return {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      isDirectory: false,
    };
  });
  const retainedFiles = new Set<string>();
  const retainedDirectories = new Set<string>();
  for (const entry of normalizedEntries) {
    if (entry.isDirectory || isPromptClutter(entry.path)) continue;
    if (!matchesProfile(entry.path, profile)) continue;
    retainedFiles.add(entry.path);
    for (const parent of parentPaths(entry.path)) retainedDirectories.add(parent);
  }

  return normalizedEntries.filter((entry) =>
    entry.isDirectory
      ? retainedDirectories.has(entry.path) && !isPromptClutter(entry.path)
      : retainedFiles.has(entry.path),
  );
}
