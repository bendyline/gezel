import { describe, expect, it } from 'vitest';
import {
  pickProjectTypeUpgradeTarget,
  projectTypeCurrentSettings,
  projectTypeParamsWithoutValue,
  upgradeProjectTypeSettings,
} from './upgrade.js';

describe('pickProjectTypeUpgradeTarget', () => {
  it('moves to the newest version in the same major', () => {
    expect(
      pickProjectTypeUpgradeTarget({
        stamp: '1.0.0',
        available: ['1.1.0', '1.0.0', '1.0.5'],
        stampResolves: true,
      }),
    ).toBe('1.1.0');
  });

  it('orders by semver, not by string', () => {
    expect(
      pickProjectTypeUpgradeTarget({
        stamp: '1.9.0',
        available: ['1.9.0', '1.10.0', '1.2.0'],
        stampResolves: true,
      }),
    ).toBe('1.10.0');
  });

  it('never crosses a major version', () => {
    expect(
      pickProjectTypeUpgradeTarget({
        stamp: '1.2.0',
        available: ['2.0.0', '1.2.0'],
        stampResolves: true,
      }),
    ).toBeNull();
    expect(
      pickProjectTypeUpgradeTarget({
        stamp: '1.2.0',
        available: ['2.0.0', '1.3.0'],
        stampResolves: true,
      }),
    ).toBe('1.3.0');
  });

  it('stays when current, and when the only newer version is a pre-release', () => {
    expect(
      pickProjectTypeUpgradeTarget({ stamp: '1.1.0', available: ['1.1.0'], stampResolves: true }),
    ).toBeNull();
    expect(
      pickProjectTypeUpgradeTarget({
        stamp: '1.1.0',
        available: ['1.2.0-rc.1', '1.1.0'],
        stampResolves: true,
      }),
    ).toBeNull();
  });

  it('never moves backward while the stamp still resolves', () => {
    expect(
      pickProjectTypeUpgradeTarget({ stamp: '1.3.0', available: ['1.2.0'], stampResolves: true }),
    ).toBeNull();
  });

  it('falls back to the newest same-major version when the stamp no longer resolves', () => {
    expect(
      pickProjectTypeUpgradeTarget({ stamp: '1.3.0', available: ['1.2.0'], stampResolves: false }),
    ).toBe('1.2.0');
  });

  it('stays on a stamp that is not semver', () => {
    expect(
      pickProjectTypeUpgradeTarget({ stamp: 'latest', available: ['1.0.0'], stampResolves: false }),
    ).toBeNull();
  });
});

describe('projectTypeParamsWithoutValue', () => {
  it('names a param added without a default and not stored', () => {
    expect(
      projectTypeParamsWithoutValue({
        previousSchema: { properties: { business: { type: 'string' } } },
        nextSchema: {
          properties: {
            business: { type: 'string' },
            city: { type: 'string' },
            size: { type: 'number', default: 5 },
          },
        },
        params: { business: 'a café' },
      }),
    ).toEqual(['city']);
  });

  it('ignores params the older version already had', () => {
    expect(
      projectTypeParamsWithoutValue({
        previousSchema: { properties: { business: { type: 'string' } } },
        nextSchema: { properties: { business: { type: 'string' } } },
        params: undefined,
      }),
    ).toEqual([]);
  });
});

describe('upgradeProjectTypeSettings', () => {
  it('takes the new value only while the project holds the old one', () => {
    const result = upgradeProjectTypeSettings({
      previous: { indexingEnabled: false, meesterManaged: true, leadLabel: 'Opponent' },
      next: { indexingEnabled: true, meesterManaged: false, leadLabel: 'Rival' },
      current: { indexingEnabled: false, meesterManaged: false, leadLabel: 'Opponent' },
    });
    expect(result.values).toEqual({ indexingEnabled: true, leadLabel: 'Rival' });
    expect(result.changed).toEqual(['leadLabel', 'indexingEnabled']);
  });

  it('adopts a newly declared value when the project holds the default', () => {
    const result = upgradeProjectTypeSettings({
      previous: {},
      next: { indexingEnabled: false },
      current: {},
    });
    expect(result.values).toEqual({ indexingEnabled: false });
  });

  it('merges tab visibility one tab at a time', () => {
    const result = upgradeProjectTypeSettings({
      previous: { tabVisibility: { overview: false, approvals: false } },
      next: { tabVisibility: { overview: true, approvals: true, tasks: false } },
      current: { tabVisibility: { overview: false, approvals: true, artifacts: false } },
    });
    expect(result.values.tabVisibility).toEqual({
      overview: true,
      approvals: true,
      artifacts: false,
      tasks: false,
    });
    expect(result.changed).toEqual(['tabVisibility']);
  });

  it('changes nothing without an older version to compare against', () => {
    expect(
      upgradeProjectTypeSettings({
        previous: null,
        next: { indexingEnabled: true, mode: 'solo' },
        current: {},
      }),
    ).toEqual({ values: {}, changed: [] });
  });

  it('reads the check-in switch from nudgeConfig', () => {
    expect(projectTypeCurrentSettings({ nudgeConfig: { enabled: false } })).toEqual({
      meesterManaged: false,
    });
  });
});
