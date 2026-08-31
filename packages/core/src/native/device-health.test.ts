import { describe, expect, it } from 'vitest';
import { DeviceSafetyPolicySchema } from '../schemas/api.js';
import {
  DeviceHealthGate,
  type DeviceHealthSample,
  createSystemDeviceHealthProbe,
  evaluateDeviceHealth,
  parseAmdSmiJson,
  parseDeviceHealthHelperJson,
  parseNvidiaSmiCsv,
  resolveDeviceSafetyPolicy,
} from './device-health.js';

function sample(
  readings: DeviceHealthSample['readings'],
  errors: string[] = [],
): DeviceHealthSample {
  return {
    sampledAt: '2026-07-11T00:00:00.000Z',
    sources: readings.length > 0 ? ['test'] : [],
    readings,
    errors,
  };
}

describe('device health telemetry parsers', () => {
  it('validates persisted policy bounds at the config boundary', () => {
    expect(DeviceSafetyPolicySchema.parse({ mode: 'guard', maxStartTemperatureC: 80 })).toEqual({
      mode: 'guard',
      maxStartTemperatureC: 80,
    });
    expect(() => DeviceSafetyPolicySchema.parse({ maxStartTemperatureC: 150 })).toThrow();
  });

  it('normalizes NVIDIA SMI temperature, margin, utilization, memory, and throttle flags', () => {
    const [reading] = parseNvidiaSmiCsv(
      '0, NVIDIA GeForce RTX 5070 Ti Laptop GPU, 82, 6, 100, 5794, 12227, Not Active, Not Active, Active\n',
    );
    expect(reading).toMatchObject({
      vendor: 'nvidia',
      deviceId: '0',
      temperatureC: 82,
      thermalMarginC: 6,
      utilizationPercent: 100,
      memoryUsedMb: 5794,
      memoryTotalMb: 12227,
      thermalSlowdown: false,
      powerBrake: true,
    });
  });

  it('normalizes nested AMD SMI metrics without depending on one release layout', () => {
    const [reading] = parseAmdSmiJson(
      JSON.stringify({
        gpu0: {
          Temperature: { Edge: { value: 71, unit: 'C' }, Hotspot: { value: 86, unit: 'C' } },
          Usage: { 'GFX Activity': '97%' },
          Memory: { 'VRAM Used': '4096 MB', 'VRAM Total': '16384 MB' },
          'Throttle Status': 'Not Active',
        },
      }),
    );
    expect(reading).toMatchObject({
      vendor: 'amd',
      deviceId: 'gpu0',
      temperatureC: 86,
      utilizationPercent: 97,
      memoryUsedMb: 4096,
      memoryTotalMb: 16384,
      thermalSlowdown: false,
    });
  });

  it('parses the bundled helper contract and preserves normalized fields', () => {
    const parsed = parseDeviceHealthHelperJson(
      JSON.stringify({
        schemaVersion: 1,
        sampledAt: '2026-07-13T00:00:00.000Z',
        sources: ['amd-adl'],
        readings: [
          {
            vendor: 'amd',
            deviceId: '0',
            name: 'Radeon',
            temperatureC: 68,
            utilizationPercent: 93,
            memoryTotalMb: 32768,
            thermalSlowdown: false,
          },
        ],
        processes: [
          {
            pid: 4242,
            name: 'gezel-llama-server.exe',
            adapterLuid: '0x00000000_0x025a7706',
            dedicatedBytes: 12_884_901_888,
            owner: 'machine-engine',
          },
        ],
        errors: [],
        diagnostics: ['nvml: driver library not found'],
      }),
    );
    expect(parsed).toMatchObject({
      sample: {
        sampledAt: '2026-07-13T00:00:00.000Z',
        sources: ['amd-adl'],
        readings: [
          {
            vendor: 'amd',
            temperatureC: 68,
            utilizationPercent: 93,
            memoryTotalMb: 32768,
            thermalSlowdown: false,
          },
        ],
        processes: [
          {
            pid: 4242,
            name: 'gezel-llama-server.exe',
            adapterLuid: '0x00000000_0x025a7706',
            dedicatedBytes: 12_884_901_888,
            owner: 'machine-engine',
          },
        ],
      },
      diagnostics: ['nvml: driver library not found'],
    });
    expect(parseDeviceHealthHelperJson('{not json')).toBeNull();
    expect(parseDeviceHealthHelperJson('{"schemaVersion":2,"readings":[]}')).toBeNull();
  });

  it('prefers the bundled helper over SMI subprocesses when it returns telemetry', async () => {
    const commands: string[] = [];
    const probe = createSystemDeviceHealthProbe({
      helperPath: '/bundled/gezel-device-health',
      commandRunner: async (command) => {
        commands.push(command);
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            sampledAt: '2026-07-13T00:00:00.000Z',
            sources: ['linux-sysfs'],
            readings: [{ vendor: 'amd', deviceId: 'card0', temperatureC: 62 }],
            errors: [],
            diagnostics: [],
          }),
          stderr: '',
        };
      },
    });
    await expect(probe.sample()).resolves.toMatchObject({
      sources: ['linux-sysfs'],
      readings: [{ vendor: 'amd', temperatureC: 62 }],
    });
    expect(commands).toEqual(['/bundled/gezel-device-health']);
  });

  it('falls back to SMI and retains helper diagnostics when native telemetry is empty', async () => {
    const commands: string[] = [];
    const probe = createSystemDeviceHealthProbe({
      preferredVendor: 'nvidia',
      helperPath: '/bundled/gezel-device-health',
      commandRunner: async (command) => {
        commands.push(command);
        if (command.includes('device-health')) {
          return {
            stdout: JSON.stringify({
              schemaVersion: 1,
              sampledAt: '2026-07-13T00:00:00.000Z',
              sources: [],
              readings: [],
              errors: [],
              diagnostics: ['nvml: driver library not found'],
            }),
            stderr: '',
          };
        }
        return {
          stdout: '0, RTX, 70, 15, 80, 1000, 16000, Not Active, Not Active, Not Active',
          stderr: '',
        };
      },
    });
    await expect(probe.sample()).resolves.toMatchObject({
      sources: ['nvidia-smi'],
      readings: [{ vendor: 'nvidia', temperatureC: 70 }],
      errors: [expect.stringContaining('nvml: driver library not found')],
    });
    expect(commands).toEqual(['/bundled/gezel-device-health', 'nvidia-smi']);
  });
});

describe('evaluateDeviceHealth', () => {
  const guard = resolveDeviceSafetyPolicy({ mode: 'guard' }, {});

  it('blocks a device above the start threshold or below thermal margin', () => {
    const decision = evaluateDeviceHealth(
      sample([
        {
          vendor: 'nvidia',
          deviceId: '0',
          temperatureC: 82,
          thermalMarginC: 6,
        },
      ]),
      guard,
    );
    expect(decision.admissible).toBe(false);
    expect(decision.reasons).toEqual([
      expect.stringContaining('exceeds 80C'),
      expect.stringContaining('below 8C'),
    ]);
  });

  it('uses the lower resume threshold once cooling has begun', () => {
    const warm = sample([{ vendor: 'amd', deviceId: '0', temperatureC: 78 }]);
    expect(evaluateDeviceHealth(warm, guard, false).admissible).toBe(true);
    expect(evaluateDeviceHealth(warm, guard, true).admissible).toBe(false);
  });

  it('can allow or fail closed when telemetry is unavailable', () => {
    expect(evaluateDeviceHealth(sample([]), guard, false).admissible).toBe(true);
    const strict = resolveDeviceSafetyPolicy({ mode: 'guard', onTelemetryFailure: 'block' }, {});
    expect(evaluateDeviceHealth(sample([]), strict, false).admissible).toBe(false);
  });

  it('marks temperatures above 105C as a hard block', () => {
    const observe = resolveDeviceSafetyPolicy({ mode: 'observe' }, {});
    const decision = evaluateDeviceHealth(
      sample([{ vendor: 'nvidia', deviceId: '0', temperatureC: 106 }]),
      observe,
    );
    expect(decision.hardBlocked).toBe(true);
    expect(decision.reasons).toContainEqual(expect.stringContaining('hard 105C safety limit'));
  });
});

describe('DeviceHealthGate', () => {
  it('requires consecutive cool samples after crossing a threshold', async () => {
    const samples = [
      sample([{ vendor: 'nvidia', deviceId: '0', temperatureC: 84, thermalMarginC: 4 }]),
      sample([{ vendor: 'nvidia', deviceId: '0', temperatureC: 74, thermalMarginC: 12 }]),
      sample([{ vendor: 'nvidia', deviceId: '0', temperatureC: 73, thermalMarginC: 13 }]),
      sample([{ vendor: 'nvidia', deviceId: '0', temperatureC: 72, thermalMarginC: 14 }]),
    ];
    let now = 0;
    let calls = 0;
    const gate = new DeviceHealthGate({
      probe: {
        sample: async () => samples[Math.min(calls++, samples.length - 1)]!,
      },
      policy: {
        mode: 'guard',
        pollIntervalMs: 500,
        maxWaitMs: 10_000,
        consecutiveHealthySamples: 3,
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(gate.admit('test')).resolves.toMatchObject({ admissible: true });
    expect(calls).toBe(4);
  });

  it('observe mode reports but never delays unhealthy work', async () => {
    let sleeps = 0;
    const gate = new DeviceHealthGate({
      probe: {
        sample: async () =>
          sample([{ vendor: 'amd', deviceId: '0', temperatureC: 95, thermalSlowdown: true }]),
      },
      policy: { mode: 'observe' },
      sleep: async () => {
        sleeps += 1;
      },
    });
    await expect(gate.admit('test')).resolves.toMatchObject({ admissible: true });
    expect(sleeps).toBe(0);
  });

  it('observe mode still gates new GPU work above 105C', async () => {
    const samples = [
      sample([{ vendor: 'amd', deviceId: '0', temperatureC: 106 }]),
      sample([{ vendor: 'amd', deviceId: '0', temperatureC: 105 }]),
    ];
    let now = 0;
    let calls = 0;
    let sleeps = 0;
    const gate = new DeviceHealthGate({
      probe: {
        sample: async () => samples[Math.min(calls++, samples.length - 1)]!,
      },
      policy: { mode: 'observe', pollIntervalMs: 500, maxWaitMs: 2_000 },
      now: () => now,
      sleep: async (ms) => {
        sleeps += 1;
        now += ms;
      },
    });

    await expect(gate.admit('test')).resolves.toMatchObject({
      admissible: true,
      hardBlocked: false,
    });
    expect(calls).toBe(2);
    expect(sleeps).toBe(1);
  });

  it('surfaces a normalized warm snapshot for status UI', async () => {
    let calls = 0;
    const gate = new DeviceHealthGate({
      probe: {
        sample: async () => {
          calls += 1;
          return sample([{ vendor: 'nvidia', deviceId: '0', temperatureC: 82, thermalMarginC: 5 }]);
        },
      },
      policy: { mode: 'observe' },
    });
    await expect(gate.status()).resolves.toMatchObject({
      state: 'warm',
      mode: 'observe',
      readings: [{ temperatureC: 82, thermalMarginC: 5 }],
    });
    await gate.status();
    expect(calls).toBe(1);
  });

  it('keeps read-only telemetry available when the admission policy is off', async () => {
    let calls = 0;
    const gate = new DeviceHealthGate({
      probe: {
        sample: async () => {
          calls += 1;
          return sample([
            {
              vendor: 'nvidia',
              deviceId: '0',
              memoryUsedMb: 4096,
              memoryTotalMb: 16384,
            },
          ]);
        },
      },
      policy: { mode: 'off' },
    });

    await expect(gate.status()).resolves.toMatchObject({
      state: 'off',
      mode: 'off',
      readings: [{ memoryUsedMb: 4096, memoryTotalMb: 16384 }],
    });
    expect(calls).toBe(1);
  });

  it('fails closed after the bounded wait budget', async () => {
    let now = 0;
    const gate = new DeviceHealthGate({
      probe: {
        sample: async () => sample([]),
      },
      policy: {
        mode: 'guard',
        onTelemetryFailure: 'block',
        pollIntervalMs: 500,
        maxWaitMs: 1_000,
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(gate.admit('test')).rejects.toThrow('device telemetry unavailable');
  });

  it('logs changed probe diagnostics once while telemetry remains unavailable', async () => {
    const logs: string[] = [];
    const gate = new DeviceHealthGate({
      probe: { sample: async () => sample([], ['helper: no supported adapter']) },
      policy: { mode: 'observe' },
      log: (message) => logs.push(message),
    });
    await gate.status(0);
    await gate.status(0);
    expect(logs.filter((line) => line.includes('helper: no supported adapter'))).toHaveLength(1);
  });
});
