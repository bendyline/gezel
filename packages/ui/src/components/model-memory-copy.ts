/**
 * Shared formatting for the model-list Size cell.
 *
 * Model and memory figures use one user-facing convention: binary-sized
 * values with the familiar GB/MB/KB labels used for RAM and GPU capacities.
 * That keeps every number directly comparable with a "24 GB GPU" or
 * "128 GB RAM" machine without asking people to translate GB and GiB.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatMemoryBytes(bytes: number): string {
  return formatBytes(bytes);
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
  return ` · ~${formatMemoryBytes(input.predictedResidentBytes)} in memory`;
}

export function modelSizeTitle(input: ModelSizeCopyInput): string {
  const onDisk = `${formatBytes(input.approxSizeBytes)} on disk.`;
  if (!input.predictedResidentBytes) return onDisk;
  const single = `Expect about ${formatMemoryBytes(input.predictedResidentBytes)} of memory to serve one chat: weights plus the KV cache at the granted context window.`;
  const slots = input.plannedSlots ?? 1;
  if (slots <= 1 || !input.reservedResidentBytes) return `${onDisk} ${single}`;
  return `${onDisk} ${single} Serving ${slots} chats at once reserves about ${formatMemoryBytes(input.reservedResidentBytes)}.`;
}
