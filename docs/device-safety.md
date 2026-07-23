# Native device safety

Gezel treats accelerator health as an admission concern shared by every local
GPU workload, not as a llama.cpp-specific feature. The same policy gates local
chat, image, and video work through `GpuArbiter`; the eval harness uses the same
normalization and thresholds between scenarios.

## What is checked

`@bendyline/gezel/native` translates host telemetry into one device-neutral
shape. Packaged Windows and Linux installs prefer the bundled, read-only
`gezel-device-health` helper:

- NVIDIA on Windows/Linux: driver-provided NVML
- AMD on Windows: driver-provided AMD Display Library (ADL)
- AMD and Intel on Linux: DRM/hwmon sysfs
- Compatibility fallback: `nvidia-smi`, `amd-smi`, then `rocm-smi`
- Other/unsupported devices: telemetry-unavailable state

The helper ships no vendor runtime. It dynamically loads libraries installed
with the display driver, emits a versioned one-shot JSON sample, and exits.
`GEZEL_DEVICE_HEALTH_BIN` can point at an operator-supplied helper; packaged
installs discover the bundled binary through `GEZEL_NATIVE_BIN_DIR`.

The policy understands current temperature, remaining thermal margin, thermal
slowdown, and hardware power-brake signals. Vendor-specific field names do not
escape the probe adapter.

No telemetry check can prove that a GPU or driver will remain healthy. These
checks reduce avoidable pressure; they do not replace driver, firmware, cooling,
or hardware diagnosis.

## Modes

Configure `deviceSafety` in `config.json` or through `PUT /api/config`:

```json
{
  "deviceSafety": {
    "mode": "guard",
    "maxStartTemperatureC": 80,
    "resumeTemperatureC": 75,
    "minThermalMarginC": 8,
    "pollIntervalMs": 5000,
    "maxWaitMs": 600000,
    "consecutiveHealthySamples": 3,
    "onTelemetryFailure": "allow"
  }
}
```

- `off`: no probes and no admission control.
- `observe` (product default): surface health and warnings without delaying
  work.
- `guard`: pause new GPU work when thresholds are exceeded. Once cooling
  begins, the lower resume threshold must pass for consecutive samples before
  work continues.

`onTelemetryFailure: "allow"` keeps unsupported consumer devices usable.
Unattended installations that require fail-closed behavior can select `block`.

Environment variables override persisted values:

- `GEZEL_DEVICE_SAFETY_MODE=off|observe|guard`
- `GEZEL_DEVICE_SAFETY_MAX_START_TEMP_C`
- `GEZEL_DEVICE_SAFETY_RESUME_TEMP_C`
- `GEZEL_DEVICE_SAFETY_MIN_THERMAL_MARGIN_C`
- `GEZEL_DEVICE_SAFETY_POLL_MS`
- `GEZEL_DEVICE_SAFETY_MAX_WAIT_MS`
- `GEZEL_DEVICE_SAFETY_HEALTHY_SAMPLES`
- `GEZEL_DEVICE_SAFETY_TELEMETRY_FAILURE=allow|block`

## Eval behavior

New local eval invocations default to guarded execution, one provider slot, and
a llama.cpp ubatch of 512. Override with:

```powershell
$env:GEZEL_EVAL_DEVICE_SAFETY='observe' # or 'off'
```

Set `GEZEL_EVAL_DEVICE_SAFETY_TELEMETRY_FAILURE=block` when an unattended host
must not proceed unless a supported telemetry adapter responds.

The matrix runner still waits for eval-native processes to drain before the
next scenario. Its process matcher covers Gezel-prefixed llama/sd/ds4 servers,
MLX, and the local video server; the shared thermal gate then handles NVIDIA or
AMD cooldown.

## User interface

The local-engine pill receives the latest authenticated health snapshot through
`GET /api/queues` on its existing poll cadence. It shows:

- temperature when available;
- warm, cooling, or safety-paused state;
- thermal margin in the details popover;
- whether the policy is guarding, observing, or off;
- telemetry-unavailable state in the details popover when the host has no
  supported adapter. The compact pill stays quiet in this expected fallback.

The primary label stays vendor-neutral. Probe source and device names remain
diagnostic details rather than product vocabulary.

## Platform limitations

The bundled helper currently targets Windows x64 plus Linux x64/arm64. macOS
keeps the existing telemetry-unavailable behavior until a Metal/IOKit adapter
is designed and reviewed. AMD ADL's direct one-shot performance-log API is
deprecated but remains driver-provided; if a future driver removes it, the
helper reports that exact adapter diagnostic and the service tries AMD SMI and
ROCm SMI. Windows ADLX was intentionally not bundled because its SDK license
adds redistribution obligations unsuitable for an automatic open-source build.

Do not increase Windows TDR registry delays as a safety feature. That masks the
timeout and can lengthen a freeze; it does not make the driver or GPU healthier.
