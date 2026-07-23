import { describe, expect, it } from 'vitest';
import {
  type DeviceHealth,
  deviceSafetyModeLabel,
  presentDeviceHealth,
} from './engine-pill-device-health.js';

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
  it('renders the hottest temperature and smallest thermal margin', () => {
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
      inline: '82°C',
      detail: 'Healthy · 82°C · 6°C thermal margin',
      tone: 'normal',
    });
  });

  it('makes cooling and blocked states explicit', () => {
    expect(presentDeviceHealth(health({ state: 'cooling' }))).toMatchObject({
      inline: 'Cooling',
      tone: 'warning',
    });
    expect(presentDeviceHealth(health({ state: 'blocked' }))).toMatchObject({
      inline: 'Paused for safety',
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

  it('explains safety modes in plain language', () => {
    expect(deviceSafetyModeLabel('guard')).toContain('new work pauses');
    expect(deviceSafetyModeLabel('observe')).toContain('warnings do not pause');
    expect(deviceSafetyModeLabel('off')).toBe('Off');
  });
});
