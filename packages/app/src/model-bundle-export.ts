/**
 * The tail of a native `.gezmodel` export: the read-back checksum pass the user
 * may decline, and the rename that publishes the finished file.
 */
import { rename } from 'node:fs/promises';
import {
  type ModelBundleByteProgress,
  verifyModelBundleArchive,
} from '@bendyline/gezel-client/node';

export interface SkippableVerification {
  /**
   * Aborted on its own when the user declines the read-back. The export's own
   * controller stays untouched, because aborting that one deletes the
   * unpublished partial file.
   */
  verifyController: AbortController;
  verificationSkipped: boolean;
}

/**
 * Check every declared file against its recorded SHA-256, unless the user asks
 * to stop waiting. Resolves `true` when the archive was fully verified and
 * `false` when the pass was skipped; a genuine verification failure still
 * throws, and so does a cancellation of the export itself.
 */
export async function verifyUnlessSkipped(opts: {
  path: string;
  active: SkippableVerification;
  signal: AbortSignal;
  onProgress: (progress: Required<ModelBundleByteProgress>) => void;
}): Promise<boolean> {
  try {
    await verifyModelBundleArchive(
      opts.path,
      opts.onProgress,
      AbortSignal.any([opts.signal, opts.active.verifyController.signal]),
    );
    return true;
  } catch (error) {
    // A skip is the user declining the read-back, not a failed export: the
    // bytes are already on disk and every checksum stays recorded in the
    // bundle manifest for the import side to enforce.
    if (!opts.active.verificationSkipped || opts.signal.aborted) throw error;
    return false;
  }
}

const PUBLISH_RETRY_LIMIT = 10;
const PUBLISH_RETRY_DELAY_MS = 100;
const HANDLE_HELD_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Move a finished export onto its final path. A skipped read-back aborts the
 * ZIP reader mid-stream, and Windows can hold that handle for a moment after
 * close — long enough to turn the publishing rename into a spurious EPERM.
 */
export async function publishExportedBundle(
  from: string,
  to: string,
  deps: {
    rename?: (from: string, to: string) => Promise<void>;
    delay?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const move = deps.rename ?? rename;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= PUBLISH_RETRY_LIMIT || !code || !HANDLE_HELD_CODES.has(code)) throw error;
      await delay(PUBLISH_RETRY_DELAY_MS);
    }
  }
}
