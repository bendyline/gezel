# Device health helper

`gezel-device-health` is a one-shot, read-only telemetry adapter bundled with
Gezel on Windows and Linux. It keeps vendor-specific native APIs outside the
daemon and emits one stable JSON shape for the device safety gate.

Adapters:

- NVIDIA on Windows/Linux: dynamically loads the driver-provided NVML library;
  on Linux it also reports per-process compute/graphics VRAM so the daemon can
  match supervised engine PIDs without exposing command lines.
- AMD on Windows: dynamically loads the driver-provided AMD Display Library
  (ADL), queries its performance log, and reads the driver's dedicated-VRAM
  usage counter.
- Windows process attribution: reads the built-in GPU Process Memory PDH
  resident-local counter, preserves the adapter LUID, and classifies Gezel
  machine, app, and development engine ancestry without exposing command lines.
  It deliberately avoids the process `Dedicated Usage` counter, which can
  retain stale committed allocations far beyond the adapter's physical use.
- AMD and Intel on Linux: reads the kernel's DRM/hwmon sysfs telemetry.

No vendor library is redistributed. An unavailable driver/API is reported in
`diagnostics` and exits successfully, allowing the service to try its existing
`nvidia-smi`, `amd-smi`, and `rocm-smi` fallbacks.

```text
gezel-device-health sample --json
gezel-device-health system --json
gezel-device-health --self-test
```

`sample` is telemetry, read on every poll. `system` reports static facts about
the machine, read once per daemon run. On Windows:

- `installedRamBytes` (`GetPhysicallyInstalledSystemMemory`), which the daemon
  compares with the OS's own RAM total to find memory firmware set aside for
  an integrated GPU.
- `adapters`: each hardware GPU as DXCore describes it (Windows 10 2004+) —
  LUID, PCI vendor/device id, name, whether it is integrated, its dedicated
  memory (an integrated GPU's carve-out), dedicated system memory, the shared
  system memory it may borrow, and driver version. DXCore reads these from the
  kernel driver without creating a device. The daemon prefers them to guesses
  from the GPU's name.

A helper that predates `system` prints usage and exits non-zero; the daemon
reads that as "unknown".

The emitted contract is versioned with `schemaVersion: 1`. New fields may be
added compatibly; incompatible changes require a new schema version and a
matching parser in `packages/core/src/native/device-health.ts`.

Build locally with `build.ps1` on Windows or `build.sh` on Linux. Both scripts
run the helper's built-in contract/parser self-test before staging it under
`native/build/<platform>/`.
