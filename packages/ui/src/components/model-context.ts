/**
 * Present a model's token capacity as the familiar compact context label.
 *
 * Model metadata mixes decimal marketing sizes (128_000) with exact binary
 * capacities (131_072). Prefer whichever interpretation lands on the familiar
 * power-of-two label so both render as "128K" instead of "125K" or "131K".
 */
export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '—';

  const decimalK = tokens / 1_000;
  const binaryK = tokens / 1_024;
  const decimalIsPowerOfTwo = Number.isInteger(decimalK) && (decimalK & (decimalK - 1)) === 0;
  const thousands = decimalIsPowerOfTwo
    ? decimalK
    : Number.isInteger(binaryK)
      ? binaryK
      : Math.round(decimalK);

  if (thousands >= 1_000 && thousands % 1_000 === 0) return `${thousands / 1_000}M`;
  if (thousands >= 1_024 && thousands % 1_024 === 0) return `${thousands / 1_024}M`;
  return `${thousands.toLocaleString()}K`;
}
