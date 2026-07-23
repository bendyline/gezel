import { describe, expect, it } from 'vitest';
import { mapEntry, normalizeSemver } from './mapper.js';
import type { NormalizedRegistryServer } from './types.js';

const FAKE_SHA = 'a'.repeat(64);

function npmServer(overrides: Partial<NormalizedRegistryServer> = {}): NormalizedRegistryServer {
  return {
    name: 'io.github.acme/widget',
    version: '1.2.3',
    title: 'Widget',
    description: 'A useful widget MCP.',
    repository: { url: 'https://github.com/acme/widget', source: 'github' },
    packages: [
      {
        registryType: 'npm',
        identifier: '@acme/widget-mcp',
        version: '1.2.3',
        transport: { type: 'stdio' },
        runtimeHint: 'npx',
        environmentVariables: [
          {
            name: 'WIDGET_API_KEY',
            description: 'API key for the widget service.',
            isRequired: true,
            isSecret: true,
          },
          {
            name: 'WIDGET_REGION',
            description: 'Default region.',
            default: 'us-east-1',
          },
        ],
      },
    ],
    official: { publishedAt: '2026-04-30T12:00:00Z' },
    ...overrides,
  };
}

describe('mapEntry — npm package', () => {
  it('emits an npm-package runtime with sha256 + entry from supplied facts', () => {
    const out = mapEntry({
      server: npmServer(),
      slug: 'acme-widget',
      license: 'MIT',
      npmFacts: { sha256: FAKE_SHA, entry: 'dist/index.js', resolvedVersion: '1.2.3' },
    });
    expect(out.identity.id).toBe('acme-widget');
    expect(out.identity.name).toBe('Widget');
    expect(out.identity.license).toBe('MIT');
    expect(out.identity.maintainer).toEqual({
      name: 'acme',
      url: 'https://github.com/acme/widget',
    });
    expect(out.version.runtime).toEqual({
      kind: 'npm-package',
      package: '@acme/widget-mcp',
      version: '1.2.3',
      sha256: FAKE_SHA,
      entry: 'dist/index.js',
      args: [],
      envHints: ['WIDGET_API_KEY', 'WIDGET_REGION'],
    });
    expect(out.version.releasedAt).toBe('2026-04-30T12:00:00Z');
    expect(out.version.tools).toEqual([]);
  });

  it('translates environmentVariables[] into typed config fields', () => {
    const out = mapEntry({
      server: npmServer(),
      slug: 'acme-widget',
      license: 'MIT',
      npmFacts: { sha256: FAKE_SHA, entry: 'dist/index.js', resolvedVersion: '1.2.3' },
    });
    expect(out.version.config).toEqual([
      {
        id: 'WIDGET_API_KEY',
        envVar: 'WIDGET_API_KEY',
        label: 'API key for the widget service',
        description: 'API key for the widget service.',
        type: 'string',
        secret: true,
        required: true,
        multiline: false,
      },
      {
        id: 'WIDGET_REGION',
        envVar: 'WIDGET_REGION',
        label: 'Default region',
        description: 'Default region.',
        type: 'string',
        secret: false,
        required: false,
        multiline: false,
        default: 'us-east-1',
      },
    ]);
  });

  it('promotes choices to an enum config field', () => {
    const server = npmServer();
    server.packages![0]!.environmentVariables = [
      {
        name: 'LOG_LEVEL',
        description: 'Logging verbosity.',
        choices: ['debug', 'info', 'warn', 'error'],
        default: 'info',
      },
    ];
    const out = mapEntry({
      server,
      slug: 'acme-widget',
      license: 'MIT',
      npmFacts: { sha256: FAKE_SHA, entry: 'dist/index.js', resolvedVersion: '1.2.3' },
    });
    const field = out.version.config[0]!;
    expect(field.type).toBe('enum');
    expect(field.options).toEqual(['debug', 'info', 'warn', 'error']);
    expect(field.default).toBe('info');
  });

  it('threads packageArguments into runtime.args', () => {
    const server = npmServer();
    server.packages![0]!.packageArguments = [
      { type: 'positional', value: '--stdio' },
      { type: 'named', name: '--data-dir', value: '/data' },
      { type: 'named', name: '--no-color' },
    ];
    const out = mapEntry({
      server,
      slug: 'acme-widget',
      license: 'MIT',
      npmFacts: { sha256: FAKE_SHA, entry: 'dist/index.js', resolvedVersion: '1.2.3' },
    });
    if (out.version.runtime.kind !== 'npm-package') throw new Error('kind');
    expect(out.version.runtime.args).toEqual(['--stdio', '--data-dir', '/data', '--no-color']);
  });

  it('uses the resolved version when registry recorded "latest"', () => {
    const server = npmServer();
    server.packages![0]!.version = 'latest';
    server.version = 'latest';
    const out = mapEntry({
      server,
      slug: 'acme-widget',
      license: 'MIT',
      npmFacts: { sha256: FAKE_SHA, entry: 'dist/index.js', resolvedVersion: '1.4.0' },
    });
    if (out.version.runtime.kind !== 'npm-package') throw new Error('kind');
    expect(out.version.runtime.version).toBe('1.4.0');
    expect(out.version.version).toBe('1.4.0');
  });

  it('marks deprecated entries with their version yanked', () => {
    const out = mapEntry({
      server: npmServer({
        official: { status: 'deprecated', publishedAt: '2026-04-30T12:00:00Z' },
      }),
      slug: 'acme-widget',
      license: 'MIT',
      npmFacts: { sha256: FAKE_SHA, entry: 'dist/index.js', resolvedVersion: '1.2.3' },
    });
    expect(out.identity.yankedVersions).toEqual(['1.2.3']);
  });

  it('throws when npm package matched but facts missing', () => {
    expect(() => mapEntry({ server: npmServer(), slug: 'acme-widget', license: 'MIT' })).toThrow();
  });
});

describe('mapEntry — http remote', () => {
  it('emits an http-mcp runtime when no npm package is present', () => {
    const out = mapEntry({
      server: {
        name: 'com.example/hosted',
        version: '1.0.0',
        title: 'Hosted',
        description: 'A hosted MCP.',
        repository: { url: 'https://github.com/example/hosted', source: 'github' },
        packages: [],
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://api.example.com/mcp',
            headers: [
              {
                name: 'Authorization',
                isRequired: true,
                isSecret: true,
                description: 'Bearer token',
              },
            ],
          },
        ],
      },
      slug: 'example-hosted',
      license: 'Apache-2.0',
    });
    if (out.version.runtime.kind !== 'http-mcp') throw new Error('kind');
    expect(out.version.runtime.url).toBe('https://api.example.com/mcp');
    expect(out.version.runtime.authHint).toBe('bearer');
    expect(out.version.runtime.envHints).toEqual(['Authorization']);
    expect(out.version.config).toHaveLength(1);
    expect(out.version.config[0]?.id).toBe('Authorization');
  });
});

describe('normalizeSemver', () => {
  it('strips a leading v', () => {
    expect(normalizeSemver('v1.2.3')).toBe('1.2.3');
  });
  it('pads short versions', () => {
    expect(normalizeSemver('1.2')).toBe('1.2.0');
    expect(normalizeSemver('1')).toBe('1.0.0');
  });
  it('passes through valid semver', () => {
    expect(normalizeSemver('2025.4.8')).toBe('2025.4.8');
    expect(normalizeSemver('1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });
});
