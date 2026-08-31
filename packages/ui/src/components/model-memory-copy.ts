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
 * Below this, a sub-term stays folded into its parent figure — a few-MB
 * slice quoted beside GB-scale numbers is noise, not breakdown. Applies
 * to the fixed context state inside KV and to the engine overhead inside
 * the weights term.
 */
const BREAKOUT_MIN_BYTES = 100 * 1024 ** 2;

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
    fixed >= BREAKOUT_MIN_BYTES && perChatBytes - fixed > 0
      ? `plus ${formatMemoryBytes(perChatBytes - fixed)} of KV cache and ${formatMemoryBytes(fixed)} of fixed context state at ${window}`
      : `plus ${formatMemoryBytes(perChatBytes)} of KV cache at ${window}`;
  // Tying the weights term back to the on-disk figure answers the question
  // the two numbers provoke on sight ("does it decompress?" — it does not).
  // Skipped when the engine's resident set is SMALLER than the file, which
  // is the normal case for a streaming engine, not an overhead to explain.
  const overheadBytes = weights - input.approxSizeBytes;
  const weightsTerm =
    overheadBytes >= BREAKOUT_MIN_BYTES
      ? `${formatBytes(input.approxSizeBytes)} of model weights and ${formatMemoryBytes(overheadBytes)} of engine overhead`
      : `${formatMemoryBytes(weights)} for the model weights`;
  const single = `Expect about ${total} of memory to serve one chat: ${weightsTerm}, ${perChat}.`;
  if (!multiSlot) return `${onDisk} ${single}`;
  return `${onDisk} ${single} Serving ${slots} chats at once reserves about ${formatMemoryBytes(input.reservedResidentBytes ?? 0)}: one copy of the weights plus ${formatMemoryBytes(perChatBytes)} for each chat.`;
}

export interface Ds4MemoryCopyInput {
  /** Download size. For a streaming engine this is NOT what stays in memory. */
  approxSizeBytes: number;
  /** Working set at the launch window: expert cache + resident state + KV. */
  residentBytes?: number | undefined;
  /**
   * Everything the context window does not move — routed-expert cache, the
   * prefill reserve, resident non-routed weights. Present only where the
   * catalog authored a per-token slope to re-base against, which is what
   * turns the quoted figure from a fixed measurement into this device's.
   */
  contextFreeBytes?: number | undefined;
  /** Granted per-turn window the figure was evaluated at. */
  effectiveContextWindow?: number | undefined;
  /**
   * Whether this device holds the whole model in memory instead of streaming
   * routed experts from SSD. When true the catalog's `residentBytes` — a
   * STREAMING working set — describes a mode this device will not use, and
   * quoting it understates the real cost by tens of gigabytes.
   */
  fullyResident?: boolean | undefined;
}

function ds4ContextBytes(input: Ds4MemoryCopyInput): number | null {
  if (input.residentBytes === undefined || input.contextFreeBytes === undefined) return null;
  const kv = input.residentBytes - input.contextFreeBytes;
  return kv > 0 ? kv : null;
}

/**
 * The memory headline beside the download size.
 *
 * No `~` when the catalog authored a slope: the figure is then a measured
 * working set re-based onto the window this device will actually launch with,
 * evaluated the same way the launcher will. The hedge stays where it is
 * earned — a flat authored footprint that does not move with the window.
 */
export function ds4MemoryHeadline(input: Ds4MemoryCopyInput): string | null {
  // Fully resident: the whole GGUF is in memory, so the download size IS the
  // weights figure. The catalog's streaming `residentBytes` (an expert-cache
  // budget) describes a different launch and would understate this one.
  if (input.fullyResident) return `${formatMemoryBytes(input.approxSizeBytes)} in memory`;
  if (!input.residentBytes) return null;
  const projected = ds4ContextBytes(input) !== null;
  return `${projected ? '' : '~'}${formatMemoryBytes(input.residentBytes)} in memory`;
}

export function ds4SizeTitle(input: Ds4MemoryCopyInput): string {
  if (input.fullyResident) {
    // The streaming sentence below is false in this mode, and it was the
    // unconditional opening of this tooltip.
    return `${formatBytes(input.approxSizeBytes)} on disk, and this device has the memory to hold all of it — nothing streams from SSD. That generates roughly ten times faster than the streaming fallback, and the memory stays occupied for as long as the model is loaded.`;
  }
  const onDisk = `${formatBytes(input.approxSizeBytes)} on disk — routed experts stream from it instead of loading, so the download size is not what the model occupies.`;
  if (!input.residentBytes) return onDisk;

  const contextBytes = ds4ContextBytes(input);
  if (contextBytes === null || input.contextFreeBytes === undefined) {
    return `${onDisk} About ${formatMemoryBytes(input.residentBytes)} stays in memory. This build authored no per-token slope, so the figure is a measured working set rather than one re-based on this device's context window.`;
  }

  const window =
    input.effectiveContextWindow !== undefined
      ? `the granted ${formatContextWindow(input.effectiveContextWindow)} window`
      : 'the granted window';
  return `${onDisk} ${formatMemoryBytes(input.residentBytes)} stays in memory at ${window}: ${formatMemoryBytes(input.contextFreeBytes)} of routed-expert cache and resident model state, plus ${formatMemoryBytes(contextBytes)} of context (KV). Only the second figure moves when you change the context size.`;
}
