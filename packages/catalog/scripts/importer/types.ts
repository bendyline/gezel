/**
 * Subset of the upstream MCP registry's `server.json` schema we care
 * about. Captured here so the rest of the importer is type-safe. The
 * authoritative schema lives at
 * `https://registry.modelcontextprotocol.io/openapi.json`; this is a
 * minimal mirror of the fields the importer actually reads.
 */

export type RegistryStatus = 'active' | 'deprecated' | 'deleted';

export type RegistryRegistryType = 'npm' | 'pypi' | 'nuget' | 'oci' | 'mcpb' | string;

export type RegistryTransportType = 'stdio' | 'streamable-http' | 'sse' | string;

/**
 * `Transport` lives both inside `Package.transport` and as items in
 * `ServerJSON.remotes[]`. For packages it's typically `{type: 'stdio'}`;
 * for remotes it carries `url` and optional `headers`.
 */
export interface RegistryTransport {
  type: RegistryTransportType;
  url?: string;
  headers?: RegistryKeyValueInput[];
}

/**
 * `KeyValueInput` covers both env vars and HTTP headers — same shape.
 * `isRequired`/`isSecret`/`default`/`value`/`description`/`placeholder`
 * are the fields that matter for the gezel `config[]` mapping.
 */
export interface RegistryKeyValueInput {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  value?: string;
  placeholder?: string;
  format?: 'string' | 'number' | 'boolean' | 'filepath';
  choices?: string[];
}

export interface RegistryArgument {
  type: 'positional' | 'named';
  name?: string;
  value?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  placeholder?: string;
  format?: 'string' | 'number' | 'boolean' | 'filepath';
  choices?: string[];
  variables?: Record<string, unknown>;
  valueHint?: string;
}

export interface RegistryPackage {
  registryType: RegistryRegistryType;
  identifier: string;
  version?: string;
  registryBaseUrl?: string;
  runtimeHint?: string;
  transport: RegistryTransport;
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryKeyValueInput[];
  fileSha256?: string;
}

export interface RegistryRepository {
  url: string;
  source?: string;
  subfolder?: string;
  id?: string;
}

/**
 * `_meta.io.modelcontextprotocol.registry/official` payload. Carried
 * on the response wrapper, not on the server object itself.
 */
export interface RegistryOfficialMeta {
  status?: RegistryStatus;
  publishedAt?: string;
  updatedAt?: string;
  statusChangedAt?: string;
  statusMessage?: string;
  isLatest?: boolean;
}

export interface RegistryServer {
  /** Reverse-DNS name (e.g., `io.github.foo/bar`). */
  name: string;
  version: string;
  title?: string;
  description?: string;
  repository?: RegistryRepository;
  packages?: RegistryPackage[];
  /** Hosted (HTTP/SSE) configurations. Same `Transport` shape as Package.transport. */
  remotes?: RegistryTransport[];
  websiteUrl?: string;
  $schema?: string;
  /** Publisher-provided metadata; we don't currently consume it. */
  _meta?: Record<string, unknown>;
}

/**
 * Wrapper carried by the registry's list and detail endpoints. The
 * `_meta.official` block holds publishedAt/status — the importer
 * hoists it onto the server during normalization.
 */
export interface RegistryServerResponse {
  server: RegistryServer;
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: RegistryOfficialMeta;
  };
}

export interface RegistryListResponse {
  servers: RegistryServerResponse[];
  metadata: {
    count: number;
    nextCursor?: string;
  };
}

/**
 * Internal: a server entry hoisted out of its wrapper. The `official`
 * block is denormalized onto the server so downstream code doesn't
 * have to thread the wrapper through.
 */
export interface NormalizedRegistryServer extends RegistryServer {
  official?: RegistryOfficialMeta;
}
