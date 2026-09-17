import { describe, expect, it } from 'vitest';
import { describeCurrentAppVersion } from './installed-service-compatibility.js';

describe('installed-service compatibility copy', () => {
  it('identifies the unstamped checkout version as a development build', () => {
    expect(describeCurrentAppVersion('0.0.0')).toBe(
      'This Gezel app is a development build (0.0.0). ',
    );
  });

  it('preserves stamped release versions', () => {
    expect(describeCurrentAppVersion('1.26259.72')).toBe('This Gezel app is version 1.26259.72. ');
  });
});
