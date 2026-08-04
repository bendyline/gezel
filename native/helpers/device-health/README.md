# Device health helper

`gezel-device-health` is a one-shot, read-only telemetry adapter bundled with
Gezel on Windows and Linux. It keeps vendor-specific native APIs outside the
daemon and emits one stable JSON shape for the device safety gate.

Adapters:

- NVIDIA on Windows/Linux: dynamically loads the driver-provided NVML library.
- AMD on Windows: dynamically loads the driver-provided AMD Display Library
  (ADL), queries its performance log, and reads the driver's dedicated-VRAM
  usage counter.
- AMD and Intel on Linux: reads the kernel's DRM/hwmon sysfs telemetry.

No vendor library is redistributed. An unavailable driver/API is reported in
`diagnostics` and exits successfully, allowing the service to try its existing
`nvidia-smi`, `amd-smi`, and `rocm-smi` fallbacks.

```text
gezel-device-health sample --json
gezel-device-health --self-test
```

The emitted contract is versioned with `schemaVersion: 1`. New fields may be
added compatibly; incompatible changes require a new schema version and a
matching parser in `packages/core/src/native/device-health.ts`.

Build locally with `build.ps1` on Windows or `build.sh` on Linux. Both scripts
run the helper's built-in contract/parser self-test before staging it under
`native/build/<platform>/`.
