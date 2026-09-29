import { describe, expect, it } from 'vitest';
import {
  QUIET_NOTICE_MS,
  STALLED_NOTICE_MS,
  emptyInstallRate,
  formatRate,
  formatTimeLeft,
  installQuiet,
  recordInstallSample,
} from './install-rate.js';

const MB = 1024 ** 2;

describe('recordInstallSample', () => {
  it('gives a steady rate from bursty progress', () => {
    let rate = emptyInstallRate();
    // A 134 MB term lands every ~33 s: 4 MB/s on average.
    const points = [
      [0, 0],
      [3_000, 0],
      [33_000, 134 * MB],
      [36_000, 134 * MB],
      [66_000, 268 * MB],
    ] as const;
    for (const [at, bytes] of points) rate = recordInstallSample(rate, at, bytes);
    expect(rate.bytesPerSecond).not.toBeNull();
    expect((rate.bytesPerSecond ?? 0) / MB).toBeGreaterThan(3.5);
    expect((rate.bytesPerSecond ?? 0) / MB).toBeLessThan(4.6);
  });

  it('says nothing until the window spans enough time', () => {
    let rate = recordInstallSample(emptyInstallRate(), 0, 0);
    rate = recordInstallSample(rate, 3_000, 50 * MB);
    expect(rate.bytesPerSecond).toBeNull();
  });

  it('starts over when the byte count drops', () => {
    let rate = recordInstallSample(emptyInstallRate(), 0, 500 * MB);
    rate = recordInstallSample(rate, 20_000, 900 * MB);
    rate = recordInstallSample(rate, 25_000, 10 * MB);
    expect(rate.samples).toHaveLength(1);
    expect(rate.bytesPerSecond).toBeNull();
  });
});

describe('installQuiet', () => {
  it('moves from moving to quiet to stalled as bytes stop arriving', () => {
    const rate = recordInstallSample(emptyInstallRate(), 1_000, 10 * MB);
    expect(installQuiet(rate, 1_000 + 5_000)).toBe('moving');
    expect(installQuiet(rate, 1_000 + QUIET_NOTICE_MS)).toBe('quiet');
    expect(installQuiet(rate, 1_000 + STALLED_NOTICE_MS)).toBe('stalled');
  });
});

describe('formatting', () => {
  it('formats rate and time left coarsely', () => {
    expect(formatRate(45 * MB)).toBe('45 MB/s');
    expect(formatRate(3.4 * MB)).toBe('3.4 MB/s');
    expect(formatTimeLeft(30 * MB, 3 * MB)).toBe('less than a minute left');
    expect(formatTimeLeft(9 * 60 * MB, MB)).toBe('about 9 min left');
    expect(formatTimeLeft(80 * 60 * MB, MB)).toBe('about 1 h 20 min left');
    expect(formatTimeLeft(120 * 60 * MB, MB)).toBe('about 2 h left');
  });
});
