/**
 * Cache-bust key for the llama-cpp backend probe.
 *
 * Bumped alongside `native/engines/llama-cpp/VERSION`. Both the Electron
 * supervisor (pre-spawn discovery) and the service (system-service-side
 * discovery) write/read the same cache file at
 * `<home>/engines/llama-cpp/backend.json`. A mismatch between the two
 * would cause cache thrash; keep them in one constant.
 *
 * Mirrors the `tag=` line of that file, so it followed upstream from the
 * rolling `b####` build tags to semver stable releases (`v0.3.0`). Nothing
 * compares these values for order — the cache is keyed on equality alone,
 * so a scheme change simply misses once and re-probes, which is the same
 * thing any bump does.
 */
export const LLAMA_ENGINE_VERSION = 'v0.3.0';
