/**
 * Turn engine/catalog quantization tags into a deliberately rough bit-depth
 * label for the model table. Tags such as Q4_K_M and oQ6e describe algorithms,
 * not a promise that every weight occupies exactly four or six bits, so the
 * approximation marker is part of the user-facing contract.
 *
 * Shared by the UI (which renders the label) and the service (which decides
 * whether a catalog-authored tag is informative enough to display at all).
 * A catalog `quantization` string is hand-written content, so it can carry
 * anything: `muse-glimmer-30b-q4` shipped `K-Quant-17GB`, lifted from the
 * upstream GGUF filename, which names no bit depth and rendered verbatim in
 * a column of `~4` / `~8`. Hence {@link quantizationBitDepths} as a public
 * predicate and the `fallback` argument below — the engine can hand us the
 * tag the model file declares about itself.
 */

/**
 * Every bit depth a tag mentions, ascending. Empty when the tag names none —
 * the signal that a label is not worth rendering as a bit depth.
 */
export function quantizationBitDepths(quantization: string | undefined): number[] {
  if (!quantization) return [];

  const normalized = quantization.toLowerCase();
  const bits = new Set<number>();

  // `4-bit` and `4 bit` are the same claim as `4bit`; the separator is
  // typography, not meaning.
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)[\s_-]*bit\b/g)) {
    bits.add(Number(match[1]));
  }
  for (const match of normalized.matchAll(/(?:i?q|[a-z]*fp|bf|f)(\d+(?:\.\d+)?)/g)) {
    bits.add(Number(match[1]));
  }

  return [...bits].filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * @param quantization the tag to describe — normally the catalog's.
 * @param fallback a tag to describe instead when `quantization` names no bit
 *   depth. Meant for the quantization the model file declares about itself,
 *   which is derived rather than authored and so cannot drift into prose.
 */
export function approximateQuantizationLabel(
  quantization: string | undefined,
  fallback?: string,
): string {
  const values = quantizationBitDepths(quantization);
  if (values.length === 0) {
    const fallbackValues = quantizationBitDepths(fallback);
    if (fallbackValues.length > 0) return formatBitDepths(fallbackValues);
    return quantization ?? '—';
  }
  return formatBitDepths(values);
}

export function quantizationTitle(
  quantization: string | undefined,
  fallback?: string,
): string | undefined {
  const usingFallback =
    quantizationBitDepths(quantization).length === 0 && quantizationBitDepths(fallback).length > 0;
  if (usingFallback) {
    return quantization
      ? `Approximate bits per weight · exact format: ${fallback} (the catalog calls it ${quantization})`
      : `Approximate bits per weight · exact format: ${fallback}`;
  }
  return quantization ? `Approximate bits per weight · exact format: ${quantization}` : undefined;
}

function formatBitDepths(values: number[]): string {
  if (values.length === 1) return `~${values[0]}`;
  return `~${values[0]}–${values[values.length - 1]}`;
}
