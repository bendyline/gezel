/**
 * What kind of thing a file is, in words a person uses — "Photo", "Slides",
 * "Spreadsheet", "TypeScript", "Test" — decided from its path and the index's
 * own classification, with no model. The Gallery groups by it, and every
 * type belongs to one family, which is what the Gallery's filter keys name.
 */

export type FileFamily = 'photos' | 'documents' | 'data' | 'media' | 'code' | 'other';

export const FILE_FAMILIES: readonly FileFamily[] = [
  'photos',
  'documents',
  'data',
  'media',
  'code',
  'other',
];

export interface FileType {
  /** Stable id: `photo`, `slides`, `code:typescript`, … */
  id: string;
  label: string;
  /** The label for a group of them: "Photos", "Slides", "TypeScript". */
  plural: string;
  family: FileFamily;
}

export interface FileTypeInput {
  path: string;
  /** The index's coarse kind (`code`, `markdown`, `doc`, `image`, `config`, …). */
  kind: string | null;
  modality: string | null;
  lang: string | null;
  /** The image carries camera facts: a capture time or a camera. */
  photo?: boolean;
  screenshot?: boolean;
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR = new Set(['__tests__', '__mocks__', 'e2e', 'spec', 'specs']);

/**
 * A test file: a `*.test.*` / `*.spec.*` name, or anything under a test
 * folder (any directory segment containing "test", plus `__mocks__`, `e2e`,
 * `spec`).
 */
export function isTestFile(path: string): boolean {
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (TEST_FILE.test(base)) return true;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!.toLowerCase();
    if (s.includes('test') || TEST_DIR.has(s)) return true;
  }
  return false;
}

const LANGUAGE_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  python: 'Python',
  ruby: 'Ruby',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  c_sharp: 'C#',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  scala: 'Scala',
  bash: 'Shell script',
  lua: 'Lua',
  sql: 'SQL',
  vue: 'Vue',
  svelte: 'Svelte',
};

/** Languages that share a label share a type, so `.ts` and `.tsx` sit together. */
const LANGUAGE_TYPE: Record<string, string> = { tsx: 'typescript', jsx: 'javascript' };

const RAW_PHOTO = /\.(heic|heif|dng|cr2|nef|arw|raf|orf|rw2)$/i;
const SPREADSHEET = /\.(xlsx|xls|ods|numbers)$/i;
const SLIDES = /\.(pptx|ppt|odp|key)$/i;
const TABLE = /\.(csv|tsv)$/i;
const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss)$/i;
const DATA = /\.(json|jsonc|json5|geojson|ndjson|ya?ml|xml|toml)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const FONT = /\.(woff2?|ttf|otf|eot)$/i;

const UNCOUNTED = new Set(['Slides', 'Settings', 'Data', 'Text', 'Code', 'Other']);

function type(id: string, label: string, family: FileFamily): FileType {
  const language = id.startsWith('code:') && !label.includes(' ');
  const plural = UNCOUNTED.has(label) || language ? label : `${label}s`;
  return { id, label, plural, family };
}

/**
 * The file's type by rule. `use` is the Village's coarser reading of a
 * structured file (data, config or style), when the caller has it; without
 * it, structured text counts as data.
 */
export function ruleFileType(input: FileTypeInput, use?: string | null): FileType {
  const { path, kind, modality } = input;
  const lower = path.toLowerCase();

  if (modality === 'image' || kind === 'image') {
    if (input.screenshot) return type('screenshot', 'Screenshot', 'photos');
    if (lower.endsWith('.svg')) return type('drawing', 'Drawing', 'photos');
    if (lower.endsWith('.ico')) return type('icon', 'Icon', 'photos');
    if (input.photo || RAW_PHOTO.test(lower)) return type('photo', 'Photo', 'photos');
    return type('image', 'Image', 'photos');
  }
  if (modality === 'audio' || kind === 'audio') return type('recording', 'Recording', 'media');
  if (modality === 'video' || kind === 'video') return type('video', 'Video', 'media');
  if (modality === 'email') return type('email', 'Email', 'documents');
  if (kind === 'doc') {
    if (lower.endsWith('.pdf')) return type('pdf', 'PDF', 'documents');
    if (SPREADSHEET.test(lower)) return type('spreadsheet', 'Spreadsheet', 'data');
    if (SLIDES.test(lower)) return type('slides', 'Slides', 'documents');
    return type('document', 'Document', 'documents');
  }
  if (kind === 'markdown') return type('note', 'Note', 'documents');
  if (kind === 'text') return type('text', 'Text', 'documents');
  if (kind === 'data' || TABLE.test(lower)) return type('table', 'Table', 'data');
  if (kind === 'code') {
    if (isTestFile(path)) return type('test', 'Test', 'code');
    if (STYLE.test(lower) || use === 'style') return type('style', 'Stylesheet', 'code');
    if (use === 'config') return type('config', 'Settings', 'code');
    if (input.lang === 'html') return type('web', 'Web page', 'code');
    const lang = input.lang ?? '';
    const label = LANGUAGE_LABEL[lang];
    if (label) return type(`code:${LANGUAGE_TYPE[lang] ?? lang}`, label, 'code');
    return type('code', 'Code', 'code');
  }
  if (kind === 'config') {
    if (use === 'config') return type('config', 'Settings', 'code');
    if (use === 'style') return type('style', 'Stylesheet', 'code');
    if (use === 'data' || DATA.test(lower)) return type('data', 'Data', 'data');
    return type('config', 'Settings', 'code');
  }
  if (ARCHIVE.test(lower)) return type('archive', 'Archive', 'other');
  if (FONT.test(lower)) return type('font', 'Font', 'other');
  return type('other', 'Other', 'other');
}
