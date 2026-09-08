/**
 * Read one package payload from npm pack's JSON output.
 *
 * npm 11 and earlier commonly returned an array (or a direct payload object).
 * npm 12 returns an object keyed by package name when packing a workspace
 * package, even with --workspaces=false.
 */
export function npmPackPayload(stdout, { packageName, payloadLabel }) {
  const parsed = JSON.parse(stdout);
  let candidates;

  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) {
    candidates = [parsed];
  } else if (parsed && typeof parsed === 'object') {
    candidates = Object.values(parsed).filter(
      (candidate) => candidate && typeof candidate === 'object' && Array.isArray(candidate.files),
    );
  } else {
    candidates = [];
  }

  const matching = candidates.filter((candidate) => candidate.name === packageName);
  const packed =
    matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : null;
  if (!packed) throw new Error(`npm pack returned no ${payloadLabel} payload`);

  return packed;
}

/** Read and normalize the file list from one npm pack payload. */
export function npmPackFiles(stdout, options) {
  const packed = npmPackPayload(stdout, options);
  return packed.files.map((file) => file.path.replaceAll('\\', '/'));
}
