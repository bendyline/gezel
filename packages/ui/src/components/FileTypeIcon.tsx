const REGULAR_FILE_ICONS = {
  pdf: 'fa-file-pdf',
  word: 'fa-file-word',
  excel: 'fa-file-excel',
  powerpoint: 'fa-file-powerpoint',
  image: 'fa-file-image',
  archive: 'fa-file-zipper',
  audio: 'fa-file-audio',
  video: 'fa-file-video',
  code: 'fa-file-code',
  text: 'fa-file-lines',
} as const;

type RegularFileIcon = (typeof REGULAR_FILE_ICONS)[keyof typeof REGULAR_FILE_ICONS];

const WORD_EXTENSIONS = new Set(['doc', 'docx', 'docm', 'dotx', 'dotm', 'odt', 'rtf']);
const POWERPOINT_EXTENSIONS = new Set([
  'ppt',
  'pptx',
  'pptm',
  'pot',
  'potx',
  'potm',
  'pps',
  'ppsx',
  'ppsm',
  'odp',
]);
const EXCEL_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'ods']);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'heic',
  'avif',
]);
const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  '7z',
  'rar',
  'tar',
  'gz',
  'bz2',
  'xz',
  'tgz',
  'tbz2',
  'jar',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mpg', 'mpeg']);
const CODE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'xml',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'swift',
  'kt',
  'kts',
  'php',
  'sql',
  'graphql',
  'vue',
  'svelte',
]);

export interface FileTypeIconDescriptor {
  style: 'fa-regular' | 'fa-solid';
  icon: RegularFileIcon | 'fa-file-csv';
}

/** Select the closest Font Awesome Free file glyph for a filename. */
export function fileTypeIconFor(name: string): FileTypeIconDescriptor {
  const baseName = name.split(/[\\/]/).pop() ?? name;
  const dot = baseName.lastIndexOf('.');
  const extension = dot > 0 ? baseName.slice(dot + 1).toLowerCase() : '';

  if (extension === 'pdf') return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.pdf };
  if (WORD_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.word };
  }
  if (POWERPOINT_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.powerpoint };
  }
  if (EXCEL_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.excel };
  }
  if (extension === 'csv' || extension === 'tsv') {
    return { style: 'fa-solid', icon: 'fa-file-csv' };
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.image };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.archive };
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.audio };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.video };
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.code };
  }
  return { style: 'fa-regular', icon: REGULAR_FILE_ICONS.text };
}

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const descriptor = fileTypeIconFor(name);
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable
    <i
      className={`${className ? `${className} ` : ''}${descriptor.style} ${descriptor.icon} fa-fw`}
      aria-hidden="true"
    />
  );
}
