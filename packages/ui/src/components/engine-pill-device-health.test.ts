import { describe, expect, it } from 'vitest';
import { type DeviceHealth, presentDeviceHealth } from './engine-pill-device-health.js';

function health(overrides: Partial<DeviceHealth>): DeviceHealth {
  return {
    state: 'healthy',
    mode: 'guard',
    sampledAt: '2026-07-11T00:00:00.000Z',
    sources: ['nvidia-smi'],
    readings: [],
    reasons: [],
    summary: 'healthy',
    ...overrides,
  };
}

describe('engine pill device health', () => {
  it('reports the hottest temperature and smallest thermal margin in the detail line', () => {
    expect(
      presentDeviceHealth(
        health({
          readings: [
            { vendor: 'nvidia', deviceId: '0', temperatureC: 74, thermalMarginC: 14 },
            { vendor: 'amd', deviceId: '1', temperatureC: 82, thermalMarginC: 6 },
          ],
        }),
      ),
    ).toEqual({
      inline: null,
      detail: 'Healthy · 82°C · 6°C thermal margin',
      tone: 'normal',
    });
  });

  it('keeps a cool machine out of the pill entirely', () => {
    expect(
      presentDeviceHealth(
        health({ readings: [{ vendor: 'nvidia', deviceId: '0', temperatureC: 49 }] }),
      ),
    ).toMatchObject({ inline: null, tone: 'normal' });
  });

  it('shows the state word without degrees when warm', () => {
    expect(
      presentDeviceHealth(
        health({
          state: 'warm',
          readings: [{ vendor: 'nvidia', deviceId: '0', temperatureC: 100, thermalMarginC: 3 }],
        }),
      ),
    ).toEqual({
      inline: 'Warm',
      detail: 'Warm · 100°C · 3°C thermal margin',
      tone: 'warning',
    });
  });

  it('keeps warnings and work delays in the machine-health detail', () => {
    expect(presentDeviceHealth(health({ state: 'cooling' }))).toEqual({
      inline: 'Cooling',
      detail: 'Cooling before new work',
      tone: 'warning',
    });
    expect(presentDeviceHealth(health({ state: 'blocked' }))).toEqual({
      inline: 'Paused for safety',
      detail: 'New work paused for safety',
      tone: 'danger',
    });
  });

  it('omits unavailable telemetry from the engine pill', () => {
    expect(presentDeviceHealth(health({ state: 'unavailable' }))).toBeNull();
  });

  it('keeps unavailable telemetry visible when guarded work is blocked', () => {
    expect(
      presentDeviceHealth(
        health({ state: 'unavailable', reasons: ['device telemetry unavailable'] }),
      ),
    ).toEqual({
      inline: 'Health check unavailable',
      detail: 'Device telemetry unavailable · new work is blocked',
      tone: 'danger',
    });
  });
});
