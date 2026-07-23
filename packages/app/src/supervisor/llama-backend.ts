/**
 * Re-exports the llama-cpp backend probe from `@bendyline/gezel/native`.
 *
 * Probe + bundled-engine discovery live in core (not the service
 * package) because the Electron supervisor needs to static-import the
 * probe from inside `app.asar/dist/main.js` BEFORE the service starts.
 * Importing from `@bendyline/gezel-service` would force electron-builder
 * to copy the service's ~100 transitive deps into `app.asar`,
 * conflicting with the canonical service-bundle tree under
 * `app.asar.unpacked` and crashing at launch with
 * `ERR_MODULE_NOT_FOUND` on whichever transitive went missing first.
 * Core is already a direct dep of the app and has no extra transitive
 * footprint, so this re-export resolves cleanly in both dev and
 * packaged builds.
 *
 * Both supervisor and service consume the same probe so a future tweak
 * (a new GPU vendor, a broader CUDA driver lookup) can't make the two
 * discovery paths drift.
 */

export type {
  DetectInput,
  DetectResult,
  GpuVendorHint,
  LlamaBackend,
} from '@bendyline/gezel/native';
export { detectLlamaBackend } from '@bendyline/gezel/native';
