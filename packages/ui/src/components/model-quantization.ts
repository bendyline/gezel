/**
 * Turn engine/catalog quantization tags into a deliberately rough bit-depth
 * label for the model table. Tags such as Q4_K_M and oQ6e describe algorithms,
 * not a promise that every weight occupies exactly four or six bits, so the
 * approximation marker is part of the user-facing contract.
 */
export function approximateQuantizationLabel(quantization: string | undefined): string {
  if (!quantization) return '—';

  const normalized = quantization.toLowerCase();
  const bits = new Set<number>();

  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*bit\b/g)) {
    bits.add(Number(match[1]));
  }
  for (const match of normalized.matchAll(/(?:i?q|[a-z]*fp|bf|f)(\d+(?:\.\d+)?)/g)) {
    bits.add(Number(match[1]));
  }

  const values = [...bits].filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length === 0) return quantization;
  if (values.length === 1) return `~${values[0]}`;
  return `~${values[0]}–${values[values.length - 1]}`;
}

export function quantizationTitle(quantization: string | undefined): string | undefined {
  return quantization ? `Approximate bits per weight · exact format: ${quantization}` : undefined;
}
