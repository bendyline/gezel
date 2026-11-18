import { describe, expect, it } from 'vitest';
import { connectorSourceProblems } from './connector-source.js';

const pin = {
  name: '@prismatic-io/components-airtable',
  version: '0.3.0',
  sha256: 'a'.repeat(64),
  entry: 'npm-dist/index.cjs',
  entrySha256: 'b'.repeat(64),
  spectral: '^10.39.1',
  license: 'Apache-2.0',
  publishedAt: '2026-11-09T21:32:39.169Z',
};

const triggerSource = {
  package: pin,
  mode: 'trigger',
  trigger: 'pollChangesTrigger',
  connection: { key: 'personalAccessToken', input: 'airtableConnection' },
  inputs: { baseId: '$config.baseId' },
  items: { resolver: true },
  idPath: '$.record.id',
  origins: ['https://api.airtable.com'],
};

describe('Spectral component sources', () => {
  it('accepts a pinned published component in trigger mode', () => {
    expect(connectorSourceProblems('spectral', triggerSource)).toEqual([]);
  });

  it('still reads a vendored-slice source as before', () => {
    expect(
      connectorSourceProblems('spectral', {
        component: 'airtable',
        action: 'listRecords',
        connectionKey: 'personalAccessToken',
        connectionInput: 'airtableConnection',
        itemsPath: '$.data',
      }),
    ).toEqual([]);
  });

  it('refuses what would run unpinned or unbounded code', () => {
    const problems = (patch: Record<string, unknown>, pinPatch: Record<string, unknown> = {}) =>
      connectorSourceProblems('spectral', {
        ...triggerSource,
        ...patch,
        package: { ...pin, ...pinPatch },
      }).join('\n');
    expect(problems({}, { name: 'left-pad' })).toMatch(/package\.name/);
    expect(problems({}, { version: '^0.3.0' })).toMatch(/exact version/);
    expect(problems({}, { sha256: 'abc' })).toMatch(/package\.sha256/);
    expect(problems({}, { entry: '../outside.cjs' })).toMatch(/inside the package/);
    expect(problems({}, { license: 'GPL-3.0' })).toMatch(/package\.license/);
    expect(problems({ origins: ['http://api.airtable.com'] })).toMatch(/https origin/);
    expect(problems({ origins: [] })).toMatch(/origins/);
    expect(problems({ trigger: undefined })).toMatch(/names a trigger/);
    expect(problems({ page: { input: 'offset', from: '$.offset' } })).toMatch(/pages itself/);
  });
});
