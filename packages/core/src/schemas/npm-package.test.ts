import { describe, expect, it } from 'vitest';
import {
  NpmPackageNameSchema,
  NpmRegistryVersionSchema,
  formatNpmRegistrySpec,
} from './npm-package.js';

describe('registry-only npm package specs', () => {
  it.each(['zod', 'playwright-core', '@types/node', '@scope/package_name', 'some.package'])(
    'accepts the package name %s',
    (name) => expect(NpmPackageNameSchema.parse(name)).toBe(name),
  );

  it.each([
    '--global',
    '../outside',
    'file:../package',
    'https://example.test/package.tgz',
    'git+https://example.test/repo.git',
    'github:user/repo',
    'zod@4',
    '@scope',
    '@scope/pkg/extra',
    'UpperCase',
  ])('rejects the non-registry package name %s', (name) => {
    expect(NpmPackageNameSchema.safeParse(name).success).toBe(false);
  });

  it.each([
    'latest',
    'next',
    '1',
    '1.2',
    '1.2.3',
    '^4',
    '~1.2.3',
    '>=1.2.3 <2.0.0',
    '1.2.x',
    '1.2.3-beta.1+build.5',
    '1.2.3 || ^2.0.0',
  ])('accepts the registry version %s', (version) => {
    expect(NpmRegistryVersionSchema.parse(version)).toBe(version);
  });

  it.each([
    '--global',
    'file:../package',
    'workspace:*',
    'npm:other@1',
    'https://example.test/package.tgz',
    'git+ssh://git@example.test/repo.git',
    '../outside',
    '1.2.3 --config=evil',
    '',
  ])('rejects the non-registry version %s', (version) => {
    expect(NpmRegistryVersionSchema.safeParse(version).success).toBe(false);
  });

  it('formats only a validated package and version', () => {
    expect(formatNpmRegistrySpec('@types/node', '^24')).toBe('@types/node@^24');
    expect(() => formatNpmRegistrySpec('--global')).toThrow();
  });
});
