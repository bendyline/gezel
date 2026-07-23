/**
 * Cache-bust key for the llama-cpp backend probe.
 *
 * Bumped alongside `native/engines/llama-cpp/VERSION`. Both the Electron
 * supervisor (pre-spawn discovery) and the service (system-service-side
 * discovery) write/read the same cache file at
 * `<home>/engines/llama-cpp/backend.json`. A mismatch between the two
 * would cause cache thrash; keep them in one constant.
 */
export const LLAMA_ENGINE_VERSION = 'b10088';
