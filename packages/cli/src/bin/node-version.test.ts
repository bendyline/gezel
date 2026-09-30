import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_MAJOR, unsupportedNodeMessage } from './node-version.js';

describe('unsupportedNodeMessage', () => {
  it('names the required and the found version for an older Node', () => {
    expect(unsupportedNodeMessage('20.20.0')).toBe(
      'Gezel needs Node.js 24 or newer (found v20.20.0).\n' +
        'Install Node.js 24 or later from https://nodejs.org, then run the command again.\n',
    );
    expect(unsupportedNodeMessage('22.19.0')).toContain('found v22.19.0');
  });

  it('accepts the minimum and anything newer', () => {
    expect(unsupportedNodeMessage('24.0.0')).toBeUndefined();
    expect(unsupportedNodeMessage('24.18.1')).toBeUndefined();
    expect(unsupportedNodeMessage('26.1.0')).toBeUndefined();
  });

  it('never blocks a version string it cannot read', () => {
    expect(unsupportedNodeMessage('')).toBeUndefined();
    expect(unsupportedNodeMessage('unknown')).toBeUndefined();
  });

  it('matches the engines field npm publishes', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { engines: { node: string } };
    expect(manifest.engines.node).toBe(`>=${MINIMUM_NODE_MAJOR}.0.0`);
  });
});
