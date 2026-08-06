/**
 * Shared formatting for the model-list Size cell.
 *
 * Decimal GB on purpose: it matches the on-disk figure users see from the
 * catalog and from their file manager. The engine pill's `formatBytes`
 * (binary GiB) is a deliberately different unit for a different surface —
 * don't unify them without deciding which one the user is comparing against.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

export interface ModelSizeCopyInput {
  approxSizeBytes: number;
  /** Weights + one slot's KV — the cost of serving a single chat. */
  predictedResidentBytes?: number | undefined;
  /** Weights + `plannedSlots` slots' KV — what the capacity broker holds. */
  reservedResidentBytes?: number | undefined;
  plannedSlots?: number | undefined;
}

/**
 * The headline beside the on-disk size. Single-slot deliberately: it is
 * what running the model costs, and it is the figure that tracks measured
 * peak RSS. The multi-slot reservation belongs in the tooltip — quoting it
 * here reads as the price of using the model at all and overstates a
 * multi-slot host by the slot count.
 */
export function modelMemoryHeadline(input: ModelSizeCopyInput): string | null {
  if (!input.predictedResidentBytes) return null;
  return ` · ~${formatBytes(input.predictedResidentBytes)} in memory`;
}

export function modelSizeTitle(input: ModelSizeCopyInput): string {
  const onDisk = `${formatBytes(input.approxSizeBytes)} on disk.`;
  if (!input.predictedResidentBytes) return onDisk;
  const single = `Expect about ${formatBytes(input.predictedResidentBytes)} of memory to serve one chat: weights plus the KV cache at the granted context window.`;
  const slots = input.plannedSlots ?? 1;
  if (slots <= 1 || !input.reservedResidentBytes) return `${onDisk} ${single}`;
  return `${onDisk} ${single} Serving ${slots} chats at once reserves about ${formatBytes(input.reservedResidentBytes)}.`;
}
