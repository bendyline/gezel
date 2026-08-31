/**
 * Device-agnostic accelerator admission and health probing.
 *
 * Policy is deliberately independent of CUDA/Vulkan/ROCm/Metal. Optional
 * command adapters translate vendor telemetry into one small reading shape;
 * the gate then applies the same temperature, thermal-margin, throttle, and
 * telemetry-failure rules everywhere. Unsupported devices remain usable by
 * default (`onTelemetryFailure: allow`) while unattended safety-sensitive
 * runs can fail closed.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { DEVICE_HARD_TEMPERATURE_C } from '../device-safety.js';
import { windowsHeadlessSpawnOptions } from './console-detach.js';

export { DEVICE_HARD_TEMPERATURE_C } from '../device-safety.js';

export type DeviceSafetyMode = 'off' | 'observe' | 'guard';
export type DeviceTelemetryFailurePolicy = 'allow' | 'block';
export type DeviceVendor = 'nvidia' | 'amd' | 'apple' | 'generic';

export interface DeviceSafetyPolicyInput {
  mode?: DeviceSafetyMode;
  maxStartTemperatureC?: number;
  resumeTemperatureC?: number;
  minThermalMarginC?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  consecutiveHealthySamples?: number;
  onTelemetryFailure?: DeviceTelemetryFailurePolicy;
}

export interface ResolvedDeviceSafetyPolicy {
  mode: DeviceSafetyMode;
  maxStartTemperatureC: number;
  resumeTemperatureC: number;
  minThermalMarginC: number;
  pollIntervalMs: number;
  maxWaitMs: number;
  consecutiveHealthySamples: number;
  onTelemetryFailure: DeviceTelemetryFailurePolicy;
}

export const DEFAULT_DEVICE_SAFETY_POLICY: ResolvedDeviceSafetyPolicy = {
  mode: 'observe',
  maxStartTemperatureC: 80,
  resumeTemperatureC: 75,
  minThermalMarginC: 8,
  pollIntervalMs: 5_000,
  maxWaitMs: 10 * 60_000,
  consecutiveHealthySamples: 3,
  onTelemetryFailure: 'allow',
};

export interface DeviceHealthReading {
  vendor: DeviceVendor;
  deviceId: string;
  name?: string;
  temperatureC?: number;
  /** Degrees remaining before the device's thermal limit, when exposed. */
  thermalMarginC?: number;
  utilizationPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  thermalSlowdown?: boolean;
  powerBrake?: boolean;
}

export type DeviceGpuProcessOwner =
  | 'machine-engine'
  | 'app-engine'
  | 'development-engine'
  | 'gezel-engine'
  | 'external';

export interface DeviceGpuProcess {
  pid: number;
  name?: string;
  /** Windows adapter identity parsed from the PDH instance, when available. */
  adapterLuid?: string;
  /** Historical wire name; Windows reports resident local bytes in this field. */
  dedicatedBytes: number;
  owner: DeviceGpuProcessOwner;
}

export interface DeviceHealthSample {
  sampledAt: string;
  sources: string[];
  readings: DeviceHealthReading[];
  /** GPU-memory process samples when the platform exposes trustworthy counters. */
  processes?: DeviceGpuProcess[];
  errors: string[];
}

export interface DeviceHealthDecision {
  admissible: boolean;
  /** True when a reading crossed the non-optional emergency temperature cutoff. */
  hardBlocked: boolean;
  telemetryAvailable: boolean;
  reasons: string[];
  summary: string;
}

export type DeviceHealthState = 'off' | 'healthy' | 'warm' | 'cooling' | 'blocked' | 'unavailable';

/** Authenticated service/UI snapshot; contains no device identifiers beyond display names. */
export interface DeviceHealthStatusSnapshot {
  state: DeviceHealthState;
  mode: DeviceSafetyMode;
  sampledAt: string | null;
  sources: string[];
  readings: DeviceHealthReading[];
  processes?: DeviceGpuProcess[];
  reasons: string[];
  summary: string;
}

export interface DeviceHealthProbe {
  sample(): Promise<DeviceHealthSample>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type DeviceHealthCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export interface SystemDeviceHealthProbeOptions {
  preferredVendor?: 'nvidia' | 'amd';
  commandRunner?: DeviceHealthCommandRunner;
  timeoutMs?: number;
  /**
   * Bundled native helper. `undefined` reads GEZEL_DEVICE_HEALTH_BIN;
   * `null` disables the helper (primarily useful in tests/operators).
   */
  helperPath?: string | null;
}

export interface DeviceHealthGateOptions {
  probe: DeviceHealthProbe;
  policy?: DeviceSafetyPolicyInput;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function resolveDeviceSafetyPolicy(
  input: DeviceSafetyPolicyInput | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDeviceSafetyPolicy {
  const envMode = env.GEZEL_DEVICE_SAFETY_MODE?.trim().toLowerCase();
  const mode =
    envMode === 'off' || envMode === 'observe' || envMode === 'guard' ? envMode : input?.mode;
  const envTelemetryFailure = env.GEZEL_DEVICE_SAFETY_TELEMETRY_FAILURE?.trim().toLowerCase();
  const onTelemetryFailure =
    envTelemetryFailure === 'allow' || envTelemetryFailure === 'block'
      ? envTelemetryFailure
      : input?.onTelemetryFailure;

  const resolved: ResolvedDeviceSafetyPolicy = {
    mode: mode ?? DEFAULT_DEVICE_SAFETY_POLICY.mode,
    maxStartTemperatureC:
      envNumber(env, 'GEZEL_DEVICE_SAFETY_MAX_START_TEMP_C') ??
      input?.maxStartTemperatureC ??
      DEFAULT_DEVICE_SAFETY_POLICY.maxStartTemperatureC,
    resumeTemperatureC:
      envNumber(env, 'GEZEL_DEVICE_SAFETY_RESUME_TEMP_C') ??
      input?.resumeTemperatureC ??
      DEFAULT_DEVICE_SAFETY_POLICY.resumeTemperatureC,
    minThermalMarginC:
      envNumber(env, 'GEZEL_DEVICE_SAFETY_MIN_THERMAL_MARGIN_C') ??
      input?.minThermalMarginC ??
      DEFAULT_DEVICE_SAFETY_POLICY.minThermalMarginC,
    pollIntervalMs:
      envNumber(env, 'GEZEL_DEVICE_SAFETY_POLL_MS') ??
      input?.pollIntervalMs ??
      DEFAULT_DEVICE_SAFETY_POLICY.pollIntervalMs,
    maxWaitMs:
      envNumber(env, 'GEZEL_DEVICE_SAFETY_MAX_WAIT_MS') ??
      input?.maxWaitMs ??
      DEFAULT_DEVICE_SAFETY_POLICY.maxWaitMs,
    consecutiveHealthySamples:
      envNumber(env, 'GEZEL_DEVICE_SAFETY_HEALTHY_SAMPLES') ??
      input?.consecutiveHealthySamples ??
      DEFAULT_DEVICE_SAFETY_POLICY.consecutiveHealthySamples,
    onTelemetryFailure: onTelemetryFailure ?? DEFAULT_DEVICE_SAFETY_POLICY.onTelemetryFailure,
  };
  // Config schemas validate persisted values, but environment overrides are an
  // operator escape hatch and still need bounded runtime behavior.
  resolved.pollIntervalMs = Math.max(500, Math.min(60_000, resolved.pollIntervalMs));
  resolved.maxWaitMs = Math.max(0, Math.min(3_600_000, resolved.maxWaitMs));
  resolved.consecutiveHealthySamples = Math.max(
    1,
    Math.min(20, Math.trunc(resolved.consecutiveHealthySamples)),
  );
  resolved.resumeTemperatureC = Math.min(
    resolved.resumeTemperatureC,
    resolved.maxStartTemperatureC,
  );
  return resolved;
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  const match = raw.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function isActive(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (['active', 'yes', 'true', '1', 'enabled'].includes(value)) return true;
  if (['not active', 'no', 'false', '0', 'disabled', 'n/a'].includes(value)) return false;
  return undefined;
}

/** Parse the stable CSV query emitted by NVIDIA SMI. Exported for tests. */
export function parseNvidiaSmiCsv(stdout: string): DeviceHealthReading[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const fields = line.split(',').map((field) => field.trim());
      if (fields.length < 10) return [];
      const [
        index,
        name,
        temperature,
        thermalMargin,
        utilization,
        memoryUsed,
        memoryTotal,
        hwThermal,
        swThermal,
        powerBrake,
      ] = fields;
      return [
        {
          vendor: 'nvidia' as const,
          deviceId: index || '0',
          ...(name ? { name } : {}),
          ...(parseNumber(temperature) !== undefined
            ? { temperatureC: parseNumber(temperature) }
            : {}),
          ...(parseNumber(thermalMargin) !== undefined
            ? { thermalMarginC: parseNumber(thermalMargin) }
            : {}),
          ...(parseNumber(utilization) !== undefined
            ? { utilizationPercent: parseNumber(utilization) }
            : {}),
          ...(parseNumber(memoryUsed) !== undefined
            ? { memoryUsedMb: parseNumber(memoryUsed) }
            : {}),
          ...(parseNumber(memoryTotal) !== undefined
            ? { memoryTotalMb: parseNumber(memoryTotal) }
            : {}),
          thermalSlowdown: isActive(hwThermal) === true || isActive(swThermal) === true,
          powerBrake: isActive(powerBrake) === true,
        },
      ];
    });
}

interface FlatMetric {
  path: string;
  value: unknown;
}

function flattenMetrics(value: unknown, path: string, out: FlatMetric[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenMetrics(entry, `${path}.${index}`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flattenMetrics(child, path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push({ path: path.toLowerCase(), value });
}

function maxMetric(
  metrics: FlatMetric[],
  predicate: (path: string) => boolean,
): number | undefined {
  const values = metrics
    .filter((metric) => predicate(metric.path))
    .map((metric) => parseNumber(metric.value))
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/**
 * Parse AMD SMI or ROCm SMI JSON without pinning to one release's field
 * spelling. Both CLIs have changed nesting and labels over time, while their
 * semantic keys consistently contain temperature/use/memory/throttle terms.
 */
export function parseAmdSmiJson(stdout: string, source = 'amd-smi'): DeviceHealthReading[] {
  let root: unknown;
  try {
    root = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }

  const candidates: Array<{ id: string; value: unknown }> = [];
  if (Array.isArray(root)) {
    root.forEach((value, index) => candidates.push({ id: String(index), value }));
  } else if (root && typeof root === 'object') {
    const entries = Object.entries(root);
    const deviceEntries = entries.filter(
      ([key, value]) =>
        value !== null &&
        typeof value === 'object' &&
        /(?:^|[-_\s])(gpu|card|device)\s*\d*/i.test(key),
    );
    if (deviceEntries.length > 0) {
      for (const [id, value] of deviceEntries) candidates.push({ id, value });
    } else {
      candidates.push({ id: '0', value: root });
    }
  }

  return candidates.flatMap(({ id, value }) => {
    const metrics: FlatMetric[] = [];
    flattenMetrics(value, '', metrics);
    const temperatureC = maxMetric(
      metrics,
      (path) =>
        /temp|temperature|junction|hotspot|edge/.test(path) &&
        !/limit|threshold|critical|maximum|max_temp/.test(path),
    );
    const utilizationPercent = maxMetric(metrics, (path) =>
      /gpu.*(?:use|util)|gfx.*(?:use|util|activity)|busy_percent|gpu%/.test(path),
    );
    const memoryUsedMb = maxMetric(
      metrics,
      (path) => /(?:vram|memory).*(?:used|usage_mb)/.test(path) && !/percent|%/.test(path),
    );
    const memoryTotalMb = maxMetric(metrics, (path) =>
      /(?:vram|memory).*(?:total|size_mb)/.test(path),
    );
    const throttleMetrics = metrics.filter((metric) => /thrott|thermal.*slow/.test(metric.path));
    const thermalSlowdown = throttleMetrics.some((metric) => isActive(metric.value) === true);
    const hasTelemetry =
      temperatureC !== undefined ||
      utilizationPercent !== undefined ||
      memoryUsedMb !== undefined ||
      throttleMetrics.length > 0;
    if (!hasTelemetry) return [];
    return [
      {
        vendor: 'amd' as const,
        deviceId: id,
        name: source,
        ...(temperatureC !== undefined ? { temperatureC } : {}),
        ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
        ...(memoryUsedMb !== undefined ? { memoryUsedMb } : {}),
        ...(memoryTotalMb !== undefined ? { memoryTotalMb } : {}),
        thermalSlowdown,
      },
    ];
  });
}

export interface DeviceHealthHelperPayload {
  sample: DeviceHealthSample;
  diagnostics: string[];
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse the versioned JSON contract emitted by gezel-device-health. */
export function parseDeviceHealthHelperJson(stdout: string): DeviceHealthHelperPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1 || !Array.isArray(root.readings)) return null;

  const readings: DeviceHealthReading[] = [];
  for (const entry of root.readings) {
    if (!entry || typeof entry !== 'object') return null;
    const reading = entry as Record<string, unknown>;
    if (
      !['nvidia', 'amd', 'apple', 'generic'].includes(String(reading.vendor)) ||
      typeof reading.deviceId !== 'string'
    ) {
      return null;
    }
    const normalized: DeviceHealthReading = {
      vendor: reading.vendor as DeviceVendor,
      deviceId: reading.deviceId,
    };
    if (typeof reading.name === 'string') normalized.name = reading.name;
    const temperatureC = optionalFiniteNumber(reading.temperatureC);
    const thermalMarginC = optionalFiniteNumber(reading.thermalMarginC);
    const utilizationPercent = optionalFiniteNumber(reading.utilizationPercent);
    const memoryUsedMb = optionalFiniteNumber(reading.memoryUsedMb);
    const memoryTotalMb = optionalFiniteNumber(reading.memoryTotalMb);
    if (temperatureC !== undefined) normalized.temperatureC = temperatureC;
    if (thermalMarginC !== undefined) normalized.thermalMarginC = thermalMarginC;
    if (utilizationPercent !== undefined) normalized.utilizationPercent = utilizationPercent;
    if (memoryUsedMb !== undefined) normalized.memoryUsedMb = memoryUsedMb;
    if (memoryTotalMb !== undefined) normalized.memoryTotalMb = memoryTotalMb;
    if (typeof reading.thermalSlowdown === 'boolean') {
      normalized.thermalSlowdown = reading.thermalSlowdown;
    }
    if (typeof reading.powerBrake === 'boolean') normalized.powerBrake = reading.powerBrake;
    readings.push(normalized);
  }

  const processes: DeviceGpuProcess[] = [];
  if (root.processes !== undefined) {
    if (!Array.isArray(root.processes)) return null;
    for (const entry of root.processes) {
      if (!entry || typeof entry !== 'object') return null;
      const process = entry as Record<string, unknown>;
      const pid = optionalFiniteNumber(process.pid);
      const dedicatedBytes = optionalFiniteNumber(process.dedicatedBytes);
      const owner = String(process.owner);
      if (
        pid === undefined ||
        !Number.isInteger(pid) ||
        pid <= 0 ||
        dedicatedBytes === undefined ||
        dedicatedBytes < 0 ||
        ![
          'machine-engine',
          'app-engine',
          'development-engine',
          'gezel-engine',
          'external',
        ].includes(owner)
      ) {
        return null;
      }
      processes.push({
        pid,
        ...(typeof process.name === 'string' ? { name: process.name } : {}),
        ...(typeof process.adapterLuid === 'string' && process.adapterLuid.length > 0
          ? { adapterLuid: process.adapterLuid }
          : {}),
        dedicatedBytes,
        owner: owner as DeviceGpuProcessOwner,
      });
    }
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    sample: {
      sampledAt:
        typeof root.sampledAt === 'string' && root.sampledAt.length > 0
          ? root.sampledAt
          : new Date().toISOString(),
      sources: strings(root.sources),
      readings,
      ...(processes.length > 0 ? { processes } : {}),
      errors: strings(root.errors),
    },
    diagnostics: strings(root.diagnostics),
  };
}

const NVIDIA_QUERY = [
  'index',
  'name',
  'temperature.gpu',
  'temperature.gpu.tlimit',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'clocks_event_reasons.hw_thermal_slowdown',
  'clocks_event_reasons.sw_thermal_slowdown',
  'clocks_event_reasons.hw_power_brake_slowdown',
].join(',');

function defaultCommandRunner(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      args,
      // Hardware CLIs are short-lived, owned children. Hide their Windows
      // console instead of detaching them; detachment gives each probe its
      // own console window and produces a visible terminal flash.
      { timeout: timeoutMs, ...windowsHeadlessSpawnOptions() },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Create a best-effort multi-vendor probe. The bundled helper gets first
 * chance, then optional host SMI CLIs preserve compatibility with custom and
 * older installations.
 */
export function createSystemDeviceHealthProbe(
  opts: SystemDeviceHealthProbeOptions = {},
): DeviceHealthProbe {
  const run = opts.commandRunner ?? defaultCommandRunner;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const helperPath =
    opts.helperPath === undefined ? process.env.GEZEL_DEVICE_HEALTH_BIN : opts.helperPath;
  return {
    async sample(): Promise<DeviceHealthSample> {
      const readings: DeviceHealthReading[] = [];
      const sources: string[] = [];
      const errors: string[] = [];
      let processes: DeviceGpuProcess[] | undefined;

      if (helperPath) {
        try {
          const result = await run(helperPath, ['sample', '--json'], timeoutMs);
          const parsed = parseDeviceHealthHelperJson(result.stdout);
          if (!parsed) {
            errors.push('device-health helper: invalid JSON contract');
          } else {
            readings.push(...parsed.sample.readings);
            sources.push(...parsed.sample.sources);
            processes = parsed.sample.processes;
            errors.push(...parsed.sample.errors.map((error) => `device-health helper: ${error}`));
            if (parsed.sample.readings.length > 0) {
              return {
                sampledAt: parsed.sample.sampledAt,
                sources,
                readings,
                ...(processes ? { processes } : {}),
                errors,
              };
            }
            errors.push(
              ...parsed.diagnostics.map((diagnostic) => `device-health helper: ${diagnostic}`),
            );
          }
        } catch (error) {
          errors.push(
            `device-health helper: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!opts.preferredVendor || opts.preferredVendor === 'nvidia') {
        try {
          const result = await run(
            'nvidia-smi',
            [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'],
            timeoutMs,
          );
          const parsed = parseNvidiaSmiCsv(result.stdout);
          if (parsed.length > 0) {
            readings.push(...parsed);
            sources.push('nvidia-smi');
          }
        } catch (error) {
          errors.push(`nvidia-smi: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!opts.preferredVendor || opts.preferredVendor === 'amd') {
        let amdReadings: DeviceHealthReading[] = [];
        try {
          const result = await run(
            'amd-smi',
            ['metric', '--temperature', '--usage', '--mem-usage', '--violation', '--json'],
            timeoutMs,
          );
          amdReadings = parseAmdSmiJson(result.stdout, 'amd-smi');
          if (amdReadings.length > 0) sources.push('amd-smi');
        } catch (error) {
          errors.push(`amd-smi: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (amdReadings.length === 0) {
          try {
            const result = await run(
              'rocm-smi',
              ['--showtemp', '--showuse', '--showmemuse', '--json'],
              timeoutMs,
            );
            amdReadings = parseAmdSmiJson(result.stdout, 'rocm-smi');
            if (amdReadings.length > 0) sources.push('rocm-smi');
          } catch (error) {
            errors.push(`rocm-smi: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        readings.push(...amdReadings);
      }

      return {
        sampledAt: new Date().toISOString(),
        sources,
        readings,
        ...(processes ? { processes } : {}),
        errors,
      };
    },
  };
}

export function evaluateDeviceHealth(
  sample: DeviceHealthSample,
  policy: ResolvedDeviceSafetyPolicy,
  cooling = false,
): DeviceHealthDecision {
  if (policy.mode === 'off') {
    return {
      admissible: true,
      hardBlocked: false,
      telemetryAvailable: sample.readings.length > 0,
      reasons: [],
      summary: 'device safety is off',
    };
  }
  if (sample.readings.length === 0) {
    const admissible = policy.onTelemetryFailure === 'allow';
    const reasons = admissible ? [] : ['device telemetry unavailable'];
    return {
      admissible,
      hardBlocked: false,
      telemetryAvailable: false,
      reasons,
      summary: admissible
        ? 'device telemetry unavailable; policy allows work'
        : 'device telemetry unavailable; policy blocks work',
    };
  }

  const reasons: string[] = [];
  let hardBlocked = false;
  const temperatureLimit = cooling ? policy.resumeTemperatureC : policy.maxStartTemperatureC;
  for (const reading of sample.readings) {
    const label = `${reading.vendor}:${reading.name ?? reading.deviceId}`;
    if (reading.temperatureC !== undefined && reading.temperatureC > temperatureLimit) {
      reasons.push(
        `${label} temperature ${reading.temperatureC}C exceeds ${temperatureLimit}C ${cooling ? 'resume' : 'start'} limit`,
      );
    }
    if (reading.temperatureC !== undefined && reading.temperatureC > DEVICE_HARD_TEMPERATURE_C) {
      hardBlocked = true;
      reasons.push(
        `${label} temperature ${reading.temperatureC}C exceeds hard ${DEVICE_HARD_TEMPERATURE_C}C safety limit`,
      );
    }
    if (reading.thermalMarginC !== undefined && reading.thermalMarginC < policy.minThermalMarginC) {
      reasons.push(
        `${label} thermal margin ${reading.thermalMarginC}C is below ${policy.minThermalMarginC}C`,
      );
    }
    if (reading.thermalSlowdown) reasons.push(`${label} reports thermal slowdown`);
    if (reading.powerBrake) reasons.push(`${label} reports hardware power braking`);
  }
  return {
    admissible: reasons.length === 0,
    hardBlocked,
    telemetryAvailable: true,
    reasons,
    summary:
      reasons.length === 0
        ? `device telemetry healthy (${sample.sources.join(', ') || 'unknown source'})`
        : reasons.join('; '),
  };
}

/**
 * Stateful admission gate with cooling hysteresis. A device that crosses a
 * start threshold must satisfy the lower resume threshold for consecutive
 * samples before work restarts, preventing hot start/stop oscillation.
 */
export class DeviceHealthGate {
  private policy: ResolvedDeviceSafetyPolicy;
  private readonly probe: DeviceHealthProbe;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private cooling = false;
  private pendingAdmission?: Promise<DeviceHealthDecision>;
  private pendingSample?: Promise<DeviceHealthSample>;
  private lastSample?: DeviceHealthSample;
  private lastSampleAt = 0;
  private admissionBlocked = false;
  private lastUnavailableDiagnostic = '';

  constructor(opts: DeviceHealthGateOptions) {
    this.probe = opts.probe;
    this.policy = resolveDeviceSafetyPolicy(opts.policy);
    this.log = opts.log ?? (() => {});
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  setPolicy(policy: DeviceSafetyPolicyInput): void {
    this.policy = resolveDeviceSafetyPolicy(policy);
    if (this.policy.mode === 'off') this.cooling = false;
  }

  getPolicy(): ResolvedDeviceSafetyPolicy {
    return { ...this.policy };
  }

  /**
   * Return a cached-or-fresh normalized snapshot for status surfaces. The
   * cache keeps a UI polling every few seconds from spawning overlapping SMI
   * processes, while admission can still force a fresh sample after it ages.
   */
  async status(maxAgeMs = 5_000): Promise<DeviceHealthStatusSnapshot> {
    const sample =
      this.lastSample && this.now() - this.lastSampleAt <= maxAgeMs
        ? this.lastSample
        : await this.sampleDevice();
    if (this.policy.mode === 'off') {
      return {
        state: 'off',
        mode: 'off',
        sampledAt: sample.sampledAt,
        sources: [...sample.sources],
        readings: sample.readings.map((reading) => ({ ...reading })),
        ...(sample.processes
          ? { processes: sample.processes.map((process) => ({ ...process })) }
          : {}),
        reasons: [],
        summary: 'Device safety is off',
      };
    }
    const decision = evaluateDeviceHealth(sample, this.policy, this.cooling);
    const state: DeviceHealthState = !decision.telemetryAvailable
      ? 'unavailable'
      : decision.admissible
        ? 'healthy'
        : decision.hardBlocked || this.admissionBlocked
          ? 'blocked'
          : this.cooling
            ? 'cooling'
            : 'warm';
    return {
      state,
      mode: this.policy.mode,
      sampledAt: sample.sampledAt,
      sources: [...sample.sources],
      readings: sample.readings.map((reading) => ({ ...reading })),
      ...(sample.processes
        ? { processes: sample.processes.map((process) => ({ ...process })) }
        : {}),
      reasons: [...decision.reasons],
      summary: decision.summary,
    };
  }

  async admit(context: string): Promise<DeviceHealthDecision> {
    if (this.policy.mode === 'off') {
      return {
        admissible: true,
        hardBlocked: false,
        telemetryAvailable: false,
        reasons: [],
        summary: 'device safety is off',
      };
    }
    if (!this.pendingAdmission) {
      this.pendingAdmission = this.runAdmission(context).finally(() => {
        this.pendingAdmission = undefined;
      });
    }
    return this.pendingAdmission;
  }

  private async runAdmission(context: string): Promise<DeviceHealthDecision> {
    const startedAt = this.now();
    let healthySamples = 0;
    let loggedWaiting = false;
    while (true) {
      const sample = await this.sampleDevice();
      const decision = evaluateDeviceHealth(sample, this.policy, this.cooling);
      if (this.policy.mode === 'observe') {
        if (!decision.hardBlocked) {
          if (!decision.admissible || !decision.telemetryAvailable) {
            this.log(`[device-health] observe ${context}: ${decision.summary}`);
          }
          if (this.cooling) {
            this.log(
              `[device-health] ${context}: temperature returned to ${DEVICE_HARD_TEMPERATURE_C}C or below; admitting work`,
            );
          }
          this.cooling = false;
          this.admissionBlocked = false;
          return { ...decision, admissible: true };
        }
        healthySamples = 0;
        this.cooling = true;
        if (!loggedWaiting) {
          this.log(`[device-health] ${context}: hard temperature gate — ${decision.summary}`);
          loggedWaiting = true;
        }
      } else if (decision.admissible) {
        healthySamples += 1;
        const required = this.cooling ? this.policy.consecutiveHealthySamples : 1;
        if (healthySamples >= required) {
          if (this.cooling || loggedWaiting) {
            this.log(
              `[device-health] ${context}: healthy for ${healthySamples} sample(s); admitting work`,
            );
          }
          this.cooling = false;
          this.admissionBlocked = false;
          return decision;
        }
      } else {
        healthySamples = 0;
        this.cooling = true;
        if (!loggedWaiting) {
          this.log(`[device-health] ${context}: cooling before admission — ${decision.summary}`);
          loggedWaiting = true;
        }
      }

      const elapsed = this.now() - startedAt;
      if (elapsed >= this.policy.maxWaitMs) {
        this.admissionBlocked = true;
        throw new Error(
          `[device-health] ${context} blocked after ${elapsed}ms: ${decision.summary}`,
        );
      }
      await this.sleep(Math.min(this.policy.pollIntervalMs, this.policy.maxWaitMs - elapsed));
    }
  }

  private async sampleDevice(): Promise<DeviceHealthSample> {
    if (!this.pendingSample) {
      this.pendingSample = this.probe
        .sample()
        .catch((error) => ({
          sampledAt: new Date().toISOString(),
          sources: [],
          readings: [],
          errors: [error instanceof Error ? error.message : String(error)],
        }))
        .then((sample) => {
          const diagnostic = sample.readings.length === 0 ? sample.errors.join('; ') : '';
          if (diagnostic && diagnostic !== this.lastUnavailableDiagnostic) {
            this.log(`[device-health] telemetry unavailable: ${diagnostic}`);
          }
          this.lastUnavailableDiagnostic = diagnostic;
          this.lastSample = sample;
          this.lastSampleAt = this.now();
          return sample;
        })
        .finally(() => {
          this.pendingSample = undefined;
        });
    }
    return this.pendingSample;
  }
}
