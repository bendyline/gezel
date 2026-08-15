import { formatContextWindow } from './model-context.js';

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
  /** Weights alone (with runtime overhead) — unlocks the tooltip breakdown. */
  weightsResidentBytes?: number | undefined;
  /** Fixed per-slot context state (SWA layers, scratch buffers). */
  kvFixedBytesPerSlot?: number | undefined;
  /** Granted per-turn window, labeling the KV figure. */
  effectiveContextWindow?: number | undefined;
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
  return `~${formatMemoryBytes(input.predictedResidentBytes)} in memory`;
}

/**
 * Below this, the fixed context state stays folded into the KV figure —
 * a few-MB slice quoted beside GB-scale numbers is noise, not breakdown.
 */
const FIXED_STATE_BREAKOUT_MIN_BYTES = 100 * 1024 ** 2;

export function modelSizeTitle(input: ModelSizeCopyInput): string {
  const onDisk = `${formatBytes(input.approxSizeBytes)} on disk.`;
  if (!input.predictedResidentBytes) return onDisk;
  const total = formatMemoryBytes(input.predictedResidentBytes);
  const slots = input.plannedSlots ?? 1;
  const multiSlot = slots > 1 && input.reservedResidentBytes;

  const weights = input.weightsResidentBytes;
  const perChatBytes = weights ? input.predictedResidentBytes - weights : 0;
  if (!weights || perChatBytes <= 0) {
    const single = `Expect about ${total} of memory to serve one chat: weights plus the KV cache at the granted context window.`;
    if (!multiSlot) return `${onDisk} ${single}`;
    return `${onDisk} ${single} Serving ${slots} chats at once reserves about ${formatMemoryBytes(input.reservedResidentBytes ?? 0)}.`;
  }

  const window =
    input.effectiveContextWindow !== undefined
      ? `the granted ${formatContextWindow(input.effectiveContextWindow)} context window`
      : 'the granted context window';
  const fixed = input.kvFixedBytesPerSlot ?? 0;
  const perChat =
    fixed >= FIXED_STATE_BREAKOUT_MIN_BYTES && perChatBytes - fixed > 0
      ? `plus ${formatMemoryBytes(perChatBytes - fixed)} of KV cache and ${formatMemoryBytes(fixed)} of fixed context state at ${window}`
      : `plus ${formatMemoryBytes(perChatBytes)} of KV cache at ${window}`;
  const single = `Expect about ${total} of memory to serve one chat: ${formatMemoryBytes(weights)} for the model weights, ${perChat}.`;
  if (!multiSlot) return `${onDisk} ${single}`;
  return `${onDisk} ${single} Serving ${slots} chats at once reserves about ${formatMemoryBytes(input.reservedResidentBytes ?? 0)}: one copy of the weights plus ${formatMemoryBytes(perChatBytes)} for each chat.`;
}
