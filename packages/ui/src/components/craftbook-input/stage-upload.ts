import type { CraftbookInputParam } from '@bendyline/gezel';
import { apiErrorMessage } from '../../api-error.js';
import { api } from '../../api.js';
import type { CraftbookInputValue } from './CraftbookInputField.js';
import { type PickedSet, filterPick } from './pick-files.js';

/**
 * Upload a pick into a fresh staging area the task adopts at launch — the
 * one path from the person's computer to a craftbook input, shared by the
 * New Task dialog and the composer's task strip. The book's input rules run
 * before a byte is sent. Resolves to the input's new value (an error value
 * when the pick cannot be used or the upload failed), or null when aborted;
 * a staging area it opened and could not fill is deleted either way.
 */
export async function stageInputUpload(args: {
  projectId: string;
  craftbookId: string;
  craftbookVersion?: string;
  input: CraftbookInputParam;
  pick: PickedSet;
  signal: AbortSignal;
  onProgress?: (value: CraftbookInputValue) => void;
}): Promise<CraftbookInputValue | null> {
  const { projectId, craftbookId, craftbookVersion, input, signal, onProgress } = args;
  const filtered = filterPick(input.spec, args.pick);
  if (filtered.error) {
    return {
      source: null,
      label: filtered.label,
      error: filtered.error,
      skipped: filtered.skipped,
    };
  }
  const total = filtered.accepted.length;
  onProgress?.({ source: null, label: filtered.label, busy: true, progress: { done: 0, total } });
  let stagingId: string | null = null;
  try {
    const staged = await api.taskInputs.createInputStaging(projectId, {
      craftbookId,
      ...(craftbookVersion ? { craftbookVersion } : {}),
      param: input.key,
      label: filtered.label,
    });
    stagingId = staged.stagingId;
    let done = 0;
    for (const picked of filtered.accepted) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      await api.taskInputs.uploadInputStagingFile(
        projectId,
        staged.stagingId,
        picked.relPath,
        picked.file,
        signal,
      );
      done += 1;
      onProgress?.({ source: null, label: filtered.label, busy: true, progress: { done, total } });
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    return {
      source: { from: 'upload', stagingId: staged.stagingId },
      label: filtered.label,
      fileCount: total,
      totalBytes: filtered.totalBytes,
      skipped: filtered.skipped,
    };
  } catch (err) {
    if (stagingId) void api.taskInputs.deleteInputStaging(projectId, stagingId).catch(() => {});
    if (signal.aborted) return null;
    return { source: null, label: filtered.label, error: apiErrorMessage(err) };
  }
}
