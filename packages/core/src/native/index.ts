/**
 * Public surface of the native-engine discovery module.
 *
 * Lives in core (not service) because the Electron supervisor must
 * static-import the probe from `app.asar/dist/main.js` before the
 * service starts. Importing from `@bendyline/gezel-service` would
 * force electron-builder to copy the service's ~100 transitive deps
 * into app.asar, conflicting with the canonical service-bundle tree
 * under app.asar.unpacked (the same kind of failure CLAUDE.md flags
 * for the embedded path). The probe uses only Node built-ins, so core
 * is a clean home for it.
 *
 * Two consumers share the surface:
 *   1. The service — calls `discoverNativeBinaries` from `startService`
 *      so system-service launches (Windows GezelService NSSM-wrapped
 *      daemon, macOS LaunchDaemon, Linux systemd unit) can find the
 *      bundled engines they never got in their env.
 *   2. The Electron supervisor — calls `detectLlamaBackend` directly
 *      and resolves the binary itself via its own
 *      `packages/app/src/supervisor/native-bin.ts` helper (which
 *      knows about `app.asar.unpacked/native-bin/` via `import.meta.url`).
 */

export type {
  DetectInput,
  DetectResult,
  GpuVendorHint,
  LlamaBackend,
  ResolvedLlamaBinary,
} from './llama-backend.js';
export { detectLlamaBackend, resolveAvailableLlamaBinary } from './llama-backend.js';
export type { LlamaQuarantineEntry, QuarantineIo } from './llama-quarantine.js';
export {
  binaryFingerprint,
  isBinaryQuarantined,
  llamaQuarantinePath,
  readLlamaQuarantine,
  recordLlamaQuarantine,
} from './llama-quarantine.js';
export type {
  DiscoverInput,
  DiscoverResult,
  NativeBinaryName,
} from './discover.js';
export { discoverNativeBinaries, resolveNativeBinaryUnder } from './discover.js';
export {
  windowsDetachedSpawnOptions,
  windowsHeadlessSpawnOptions,
} from './console-detach.js';
export { LLAMA_ENGINE_VERSION } from './llama-engine-version.js';
export { resolvePlatformKey } from './platform-key.js';
export type {
  CommandResult,
  DeviceHealthCommandRunner,
  DeviceHealthDecision,
  DeviceHealthGateOptions,
  DeviceHealthProbe,
  DeviceHealthReading,
  DeviceHealthSample,
  DeviceHealthState,
  DeviceHealthStatusSnapshot,
  DeviceSafetyMode,
  DeviceSafetyPolicyInput,
  DeviceTelemetryFailurePolicy,
  DeviceVendor,
  ResolvedDeviceSafetyPolicy,
  SystemDeviceHealthProbeOptions,
} from './device-health.js';
export {
  createSystemDeviceHealthProbe,
  DEFAULT_DEVICE_SAFETY_POLICY,
  DEVICE_HARD_TEMPERATURE_C,
  DeviceHealthGate,
  evaluateDeviceHealth,
  parseAmdSmiJson,
  parseNvidiaSmiCsv,
  resolveDeviceSafetyPolicy,
} from './device-health.js';
export type { FindGpuPanicOptions, GpuPanicRecord } from './gpu-panic.js';
export { findRecentGpuPanics, GPU_PANIC_RE } from './gpu-panic.js';
