// Node globals the reader and catalog host touch, injected into the worker bundle.

/**
 * The reader's Buffer uses: decoding a document body as UTF-8, and sizing
 * metadata and location provenance strings in UTF-8 bytes.
 */
export const Buffer = {
  from: (bytes: Uint8Array) =>
    Object.assign(bytes, { toString: () => new TextDecoder().decode(bytes) }),
  byteLength: (value: string | Uint8Array) =>
    typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength,
};

/** The catalog host yields between shard warm-ups with setImmediate. */
export const setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
  setTimeout(callback, 0, ...args);
