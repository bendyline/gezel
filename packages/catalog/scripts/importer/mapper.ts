import type { ToolsetConfigField, ToolsetIdentity, ToolsetVersionManifest } from '@bendyline/gezel';
import { categorizeToolset } from '../../src/categorize.js';
import { isDeprecated, pickNpmStdioPackage } from './filter.js';
import type {
  NormalizedRegistryServer,
  RegistryArgument,
  RegistryKeyValueInput,
  RegistryTransport,
} from './types.js';

/**
 * Network-resolved facts about an npm package, supplied to the mapper
 * by the npm-metadata resolver. Required because the mapper can't
 * reasonably fall back when missing — better to fail upstream than
 * emit a half-formed manifest.
 */
export interface NpmPackageFacts {
  /** Hex sha256 of the tarball — verified after download by the install pipeline. */
  sha256: string;
  /**
   * Entry path relative to the extracted package root. Derived from
   * the package's `bin` field (preferred — that's what `npx` runs)
   * or `main` field (fallback). The install pipeline expects this to
   * be a valid file inside the tarball.
   */
  entry: string;
  /**
   * Resolved version. Distinct from the package's declared version
   * because the registry sometimes records `"latest"` instead of a
   * pinned semver — the npm-metadata resolver normalizes that to a
   * concrete version via npm's dist-tags.
   */
  resolvedVersion: string;
}

export interface MapperInput {
  server: NormalizedRegistryServer;
  /** Slug already allocated by `SlugAllocator`. */
  slug: string;
  /** SPDX license id resolved by `license-resolver`. */
  license: string;
  /**
   * For npm/stdio entries, the resolved npm metadata. Required for
   * any entry that produced an npm runtime.
   */
  npmFacts?: NpmPackageFacts;
}

export interface MapperOutput {
  identity: ToolsetIdentity;
  version: ToolsetVersionManifest;
  diagnostics: string[];
}

/**
 * Build the gezel-shaped identity + version manifest for one upstream
 * registry entry. Pure; all I/O happens upstream of this call.
 */
export function mapEntry(input: MapperInput): MapperOutput {
  const { server, slug, license } = input;
  const diagnostics: string[] = [];

  const npmPkg = pickNpmStdioPackage(server);
  let runtime: ToolsetVersionManifest['runtime'];
  let envHints: string[];

  if (npmPkg) {
    if (!input.npmFacts) {
      throw new Error(`mapEntry(${server.name}): npm package matched but npmFacts not supplied`);
    }
    envHints = (npmPkg.environmentVariables ?? [])
      .map((e) => e.name)
      .filter((n): n is string => Boolean(n));
    runtime = {
      kind: 'npm-package',
      package: npmPkg.identifier,
      version: input.npmFacts.resolvedVersion,
      sha256: input.npmFacts.sha256,
      entry: input.npmFacts.entry,
      args: argsFrom(npmPkg.packageArguments),
      envHints,
    };
  } else {
    const remote = server.remotes?.[0];
    if (!remote || !remote.url) {
      throw new Error(`mapEntry(${server.name}): no npm package and no remotes[] url`);
    }
    const httpRuntime = httpRuntimeFromRemote(remote);
    runtime = httpRuntime;
    envHints = httpRuntime.envHints;
  }

  const config = configFieldsFrom(npmPkg?.environmentVariables, server.remotes?.[0]);

  const releasedAt =
    server.official?.publishedAt ?? server.official?.updatedAt ?? new Date().toISOString();

  // Prefer the resolved (pinned) npm version when the registry
  // recorded `"latest"` or anything else non-semver.
  const baseVersion = input.npmFacts?.resolvedVersion ?? server.version;
  const versionStr = normalizeSemver(baseVersion);
  if (versionStr !== baseVersion) {
    diagnostics.push(`version normalized: ${baseVersion} → ${versionStr}`);
  }

  const version: ToolsetVersionManifest = {
    schemaVersion: 1,
    version: versionStr,
    releasedAt,
    runtime,
    tools: [],
    config,
  };

  const maintainer = maintainerFrom(server);
  const name = server.title?.trim() || derivedName(server.name);
  const description = (server.description ?? '').trim();
  const identity: ToolsetIdentity = {
    schemaVersion: 1,
    kind: 'toolset',
    id: slug,
    name,
    description,
    tags: [],
    maintainer,
    license,
    yankedVersions: isDeprecated(server) ? [versionStr] : [],
    category: categorizeToolset({
      id: slug,
      name,
      description,
      tags: [],
      maintainerName: maintainer.name,
    }),
  };

  return { identity, version, diagnostics };
}

function argsFrom(args: RegistryArgument[] | undefined): string[] {
  if (!args || args.length === 0) return [];
  const out: string[] = [];
  for (const a of args) {
    if (a.type === 'named' && a.name) {
      out.push(a.name);
      const v = a.value ?? a.default;
      if (v !== undefined && v !== '') out.push(v);
      continue;
    }
    const v = a.value ?? a.default;
    if (v !== undefined && v !== '') out.push(v);
  }
  return out;
}

interface HttpMcpRuntime {
  kind: 'http-mcp';
  url: string;
  transport: 'streamable-http' | 'sse';
  authHint: 'none' | 'bearer' | 'oauth';
  envHints: string[];
}

function httpRuntimeFromRemote(remote: RegistryTransport): HttpMcpRuntime {
  const headers = remote.headers ?? [];
  const hasBearer = headers.some((h) => /^authorization$/i.test(h.name));
  // Upstream uses `streamable-http`/`sse`/(`stdio`, ignored). Anything
  // else is treated as streamable-http — the modern default.
  const transport: 'streamable-http' | 'sse' = remote.type === 'sse' ? 'sse' : 'streamable-http';
  return {
    kind: 'http-mcp',
    url: remote.url ?? '',
    transport,
    authHint: hasBearer ? 'bearer' : 'none',
    envHints: headers.map((h) => h.name).filter((n): n is string => Boolean(n)),
  };
}

function configFieldsFrom(
  envVars: RegistryKeyValueInput[] | undefined,
  firstRemote: RegistryTransport | undefined,
): ToolsetConfigField[] {
  const fields: ToolsetConfigField[] = [];
  for (const env of envVars ?? []) {
    if (!env.name) continue;
    fields.push(toConfigField(env));
  }
  for (const header of firstRemote?.headers ?? []) {
    if (!header.name) continue;
    if (fields.some((f) => f.id === header.name)) continue;
    fields.push(toConfigField(header));
  }
  return fields;
}

function toConfigField(input: RegistryKeyValueInput): ToolsetConfigField {
  const desc = input.description?.trim();
  const label = desc ? desc.split('.', 1)[0]?.trim() || input.name : input.name;
  const defaultValue = input.default ?? input.value;
  const field: ToolsetConfigField = {
    id: input.name,
    envVar: input.name,
    label,
    type: 'string',
    secret: input.isSecret ?? false,
    required: input.isRequired ?? false,
    multiline: false,
  };
  if (desc) field.description = desc;
  if (defaultValue !== undefined && defaultValue !== '') field.default = defaultValue;
  if (input.placeholder) field.placeholder = input.placeholder;
  if (input.choices && input.choices.length > 0) {
    field.type = 'enum';
    field.options = [...input.choices];
  }
  return field;
}

function maintainerFrom(server: NormalizedRegistryServer): { name: string; url?: string } {
  const ownerSegment = server.name.split('/', 2)[0] ?? server.name;
  const parts = ownerSegment.split('.');
  let owner = parts[parts.length - 1] ?? server.name;
  if (server.repository?.url) {
    const m = /github\.com[/:]([^/]+)\//i.exec(server.repository.url);
    if (m?.[1]) owner = m[1];
  }
  return {
    name: owner,
    ...(server.repository?.url ? { url: server.repository.url } : {}),
  };
}

function derivedName(reverseDns: string): string {
  const last = reverseDns.split('/', 2)[1] ?? reverseDns;
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Coerce upstream version strings to gezel's `SemverRegex`. Returns
 * the same string when already valid; pads short forms (`1.2` →
 * `1.2.0`); strips a leading `v`. Returns the input verbatim when
 * we can't salvage it — caller decides what to do.
 */
export function normalizeSemver(raw: string): string {
  let v = raw.trim();
  if (v.startsWith('v') || v.startsWith('V')) v = v.slice(1);
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(v)) return v;
  if (/^\d+\.\d+$/.test(v)) return `${v}.0`;
  if (/^\d+$/.test(v)) return `${v}.0.0`;
  const dateMatch = /^(\d{4})\.(\d{1,2})$/.exec(v);
  if (dateMatch) return `${dateMatch[1]}.${dateMatch[2]}.0`;
  return v;
}
