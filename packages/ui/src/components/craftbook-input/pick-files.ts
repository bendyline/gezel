import {
  type CraftbookParamInput,
  type TaskInputSkipReason,
  effectiveInputLimits,
  inputAccepts,
  isInputJunkName,
} from '@bendyline/gezel';

/** One file the user picked, with the path it keeps inside the input folder. */
export interface PickedFile {
  file: File;
  relPath: string;
}

export interface PickedSet {
  /** What the pick is called in the UI and the prompt: the folder's name, or a file count. */
  label: string;
  files: PickedFile[];
}

export interface FilteredPick {
  label: string;
  accepted: PickedFile[];
  skipped: Array<{ path: string; reason: TaskInputSkipReason }>;
  totalBytes: number;
  /** Set when the pick cannot be used at all; the message is shown as-is. */
  error?: string;
}

/**
 * A folder chosen through `<input webkitdirectory>`: every file carries
 * `webkitRelativePath` = `<picked folder>/<path inside it>`. The picked
 * folder's own name becomes the label and is dropped from each path, so the
 * files land at the top of the task's input folder.
 */
export function pickFromDirectoryInput(list: FileList): PickedSet {
  const files = [...list];
  const root = files[0]?.webkitRelativePath.split('/')[0] ?? '';
  return {
    label: root || 'Picked folder',
    files: files.map((file) => {
      const parts = file.webkitRelativePath.split('/');
      return { file, relPath: parts.length > 1 ? parts.slice(1).join('/') : file.name };
    }),
  };
}

/** Loose files chosen through `<input multiple>` sit side by side. */
export function pickFromFileInput(list: FileList): PickedSet {
  const files = [...list];
  return {
    label: files.length === 1 ? files[0]!.name : `${files.length} files`,
    files: files.map((file) => ({ file, relPath: file.name })),
  };
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    // `readEntries` hands back at most ~100 entries per call; an empty batch
    // is the only end-of-directory signal.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function collectEntry(entry: FileSystemEntry, prefix: string, out: PickedFile[]) {
  if (isInputJunkName(entry.name)) return;
  const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, relPath });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await collectEntry(child, relPath, out);
  }
}

/**
 * Whatever was dropped: one folder reads like a folder pick (its name is the
 * label, its contents land at the top); anything else keeps its names.
 */
export async function pickFromDrop(items: DataTransferItemList): Promise<PickedSet> {
  const entries = [...items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  const files: PickedFile[] = [];
  if (entries.length === 1 && entries[0]!.isDirectory) {
    const folder = entries[0]!;
    const children = await readAllEntries((folder as FileSystemDirectoryEntry).createReader());
    for (const child of children) await collectEntry(child, '', files);
    return { label: folder.name, files };
  }
  for (const entry of entries) await collectEntry(entry, '', files);
  return {
    label: files.length === 1 ? files[0]!.file.name : `${files.length} files`,
    files,
  };
}

/**
 * Apply the book's input rules before a single byte is sent, with the same
 * limits the service enforces: junk and unaccepted types are skipped and
 * listed, too-large files are skipped, and a pick over the count or total
 * size is refused outright rather than silently cut short.
 */
export function filterPick(spec: CraftbookParamInput, pick: PickedSet): FilteredPick {
  const limits = effectiveInputLimits(spec);
  const accepted: PickedFile[] = [];
  const skipped: FilteredPick['skipped'] = [];
  let totalBytes = 0;
  for (const picked of [...pick.files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const segments = picked.relPath.split('/');
    if (segments.some((segment) => isInputJunkName(segment))) continue;
    if (!inputAccepts(spec, picked.relPath)) {
      skipped.push({ path: picked.relPath, reason: 'not-accepted' });
      continue;
    }
    if (picked.file.size > limits.maxFileBytes) {
      skipped.push({ path: picked.relPath, reason: 'too-large' });
      continue;
    }
    accepted.push(picked);
    totalBytes += picked.file.size;
  }
  const base = { label: pick.label, accepted, skipped, totalBytes };
  if (accepted.length === 0) {
    const types = spec.accept ? ` (${spec.accept.join(', ')})` : '';
    return { ...base, error: `Nothing here is a file this craftbook reads${types}.` };
  }
  if (spec.kind === 'file' && accepted.length > 1) {
    return { ...base, error: 'This input takes a single file.' };
  }
  if (accepted.length > limits.maxFiles) {
    return {
      ...base,
      error: `That is more than the ${limits.maxFiles} files this craftbook can take. Pick a smaller folder.`,
    };
  }
  if (totalBytes > limits.maxBytes) {
    return { ...base, error: 'Those files are larger than this craftbook can take together.' };
  }
  return base;
}
