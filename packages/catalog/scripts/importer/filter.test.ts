import { describe, expect, it } from 'vitest';
import { classify, hasUsableRemote, isDeprecated, pickNpmStdioPackage } from './filter.js';
import type { NormalizedRegistryServer } from './types.js';

function svr(partial: Partial<NormalizedRegistryServer>): NormalizedRegistryServer {
  return { name: 'io.github.t/x', version: '1.0.0', ...partial };
}

describe('classify', () => {
  it('drops deleted entries', () => {
    expect(classify(svr({ official: { status: 'deleted' } })).kind).toBe('drop');
  });

  it('keeps deprecated entries (yank handled later)', () => {
    expect(
      classify(
        svr({
          official: { status: 'deprecated' },
          packages: [
            {
              registryType: 'npm',
              identifier: '@x/y',
              version: '1.0.0',
              transport: { type: 'stdio' },
            },
          ],
        }),
      ).kind,
    ).toBe('keep');
  });

  it('keeps npm/stdio entries', () => {
    expect(
      classify(
        svr({
          packages: [
            {
              registryType: 'npm',
              identifier: '@x/y',
              version: '1.0.0',
              transport: { type: 'stdio' },
            },
          ],
        }),
      ).kind,
    ).toBe('keep');
  });

  it('keeps remote-only entries', () => {
    expect(
      classify(
        svr({
          packages: [],
          remotes: [{ url: 'https://example.com/mcp', type: 'streamable-http' }],
        }),
      ).kind,
    ).toBe('keep');
  });

  it('drops pypi/uvx entries (out of MVP runtime coverage)', () => {
    const result = classify(
      svr({
        packages: [
          {
            registryType: 'pypi',
            identifier: 'mcp-server-x',
            version: '1.0.0',
            runtimeHint: 'uvx',
            transport: { type: 'stdio' },
          },
        ],
      }),
    );
    expect(result.kind).toBe('drop');
    if (result.kind === 'drop') expect(result.reason).toBe('no-runnable-package');
  });

  it('drops oci/docker entries', () => {
    const result = classify(
      svr({
        packages: [
          {
            registryType: 'oci',
            identifier: 'ghcr.io/x/mcp',
            version: '1.0.0',
            runtimeHint: 'docker',
            transport: { type: 'stdio' },
          },
        ],
      }),
    );
    expect(result.kind).toBe('drop');
  });

  it('drops entries with no packages and no remotes', () => {
    expect(classify(svr({})).kind).toBe('drop');
  });

  it('treats missing official block as active', () => {
    expect(
      classify(
        svr({
          packages: [
            {
              registryType: 'npm',
              identifier: '@x/y',
              version: '1.0.0',
              transport: { type: 'stdio' },
            },
          ],
        }),
      ).kind,
    ).toBe('keep');
  });
});

describe('pickNpmStdioPackage', () => {
  it('returns the first npm/stdio package, ignoring sibling oci entries', () => {
    const pkg = pickNpmStdioPackage(
      svr({
        packages: [
          {
            registryType: 'oci',
            identifier: 'x',
            version: '1.0.0',
            runtimeHint: 'docker',
            transport: { type: 'stdio' },
          },
          {
            registryType: 'npm',
            identifier: '@x/y',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
        ],
      }),
    );
    expect(pkg?.identifier).toBe('@x/y');
  });

  it('skips packages whose transport.type is not stdio', () => {
    const pkg = pickNpmStdioPackage(
      svr({
        packages: [
          {
            registryType: 'npm',
            identifier: '@x/y',
            version: '1.0.0',
            transport: { type: 'streamable-http' },
          },
        ],
      }),
    );
    expect(pkg).toBeNull();
  });
});

describe('hasUsableRemote', () => {
  it('rejects empty/missing remotes', () => {
    expect(hasUsableRemote(svr({}))).toBe(false);
    expect(hasUsableRemote(svr({ remotes: [] }))).toBe(false);
    expect(hasUsableRemote(svr({ remotes: [{ type: 'streamable-http' } as never] }))).toBe(false);
  });

  it('accepts a non-empty url', () => {
    expect(hasUsableRemote(svr({ remotes: [{ url: 'https://x', type: 'streamable-http' }] }))).toBe(
      true,
    );
  });
});

describe('isDeprecated', () => {
  it('reads official.status', () => {
    expect(isDeprecated(svr({ official: { status: 'deprecated' } }))).toBe(true);
    expect(isDeprecated(svr({ official: { status: 'active' } }))).toBe(false);
    expect(isDeprecated(svr({}))).toBe(false);
  });
});
