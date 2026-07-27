import type { QueueStatusResponse } from '@bendyline/gezel-client';

export type DeviceHealth = NonNullable<QueueStatusResponse['deviceHealth']>;
export type DeviceHealthTone = 'normal' | 'warning' | 'danger' | 'muted';

export function presentDeviceHealth(health: DeviceHealth): {
  inline: string | null;
  detail: string;
  tone: DeviceHealthTone;
} | null {
  const temperatures = health.readings
    .map((reading) => reading.temperatureC)
    .filter((value): value is number => typeof value === 'number');
  const margins = health.readings
    .map((reading) => reading.thermalMarginC)
    .filter((value): value is number => typeof value === 'number');
  const temperature = temperatures.length > 0 ? Math.max(...temperatures) : undefined;
  const margin = margins.length > 0 ? Math.min(...margins) : undefined;
  const temperatureText = temperature === undefined ? '' : `${Math.round(temperature)}°C`;
  const marginText = margin === undefined ? '' : `${Math.round(margin)}°C thermal margin`;
  const metrics = [temperatureText, marginText].filter(Boolean).join(' · ');

  switch (health.state) {
    case 'healthy':
      // Nothing to say in the pill: a cool machine is the expected case, and
      // a running temperature there is noise the user has to re-read every
      // glance. The popover's Machine health row keeps the number for anyone
      // who wants it.
      return {
        inline: null,
        detail: `Healthy${metrics ? ` · ${metrics}` : ''}`,
        tone: 'normal',
      };
    case 'warm':
      // State word only — same reasoning as `healthy`. "Warm" is the signal;
      // the exact degrees belong in the popover next to the thermal margin,
      // where they have context.
      return {
        inline: 'Warm',
        detail: `Warm${metrics ? ` · ${metrics}` : ''}`,
        tone: 'warning',
      };
    case 'cooling':
      return {
        inline: 'Cooling',
        detail: `Cooling before new work${metrics ? ` · ${metrics}` : ''}`,
        tone: 'warning',
      };
    case 'blocked':
      return {
        inline: 'Paused for safety',
        detail: `New work paused for safety${metrics ? ` · ${metrics}` : ''}`,
        tone: 'danger',
      };
    case 'unavailable':
      // Missing optional vendor telemetry is a platform capability gap, not
      // an engine condition. In particular, the bundled telemetry helper is
      // intentionally Windows/Linux-only today. Omit it from the pill rather
      // than presenting an expected absence as machine-health information.
      // Keep a guarded fail-closed policy visible because in that case the
      // missing telemetry really does prevent the engine from starting work.
      return health.mode === 'guard' && health.reasons.length > 0
        ? {
            inline: 'Health check unavailable',
            detail: 'Device telemetry unavailable · new work is blocked',
            tone: 'danger',
          }
        : null;
    case 'off':
      return {
        inline: null,
        detail: 'Device safety is off',
        tone: 'muted',
      };
  }
}

export function deviceSafetyModeLabel(mode: DeviceHealth['mode'] | undefined): string {
  if (mode === 'guard') return 'Guarded · new work pauses when the device is too warm';
  if (mode === 'observe') return 'Observing · warnings do not pause work';
  return 'Off';
}
