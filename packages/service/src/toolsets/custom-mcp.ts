import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  CustomMcpImportWarning,
  InstalledToolset,
  ToolsetRuntime,
  ToolsetsScope,
} from '@bendyline/gezel';
import type { McpServerSpec } from '../providers/mcp-bridge.js';
import type { SecretStore } from '../secrets/types.js';

export const PROJECT_MCP_CONFIG_PATHS = [
  '.gezel/mcp.json',
  '.vscode/mcp.json',
  '.mcp.json',
] as const;

type ProjectMcpConfigPath = (typeof PROJECT_MCP_CONFIG_PATHS)[number];
export type CustomMcpRuntime = Extract<ToolsetRuntime, { kind: 'custom-mcp' }>;

export interface NormalizedMcpServer {
  name: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args: string[];
  cwd?: string;
  envFile?: string;
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export interface ParsedMcpConfig {
  servers: NormalizedMcpServer[];
  warnings: CustomMcpImportWarning[];
}

export interface DiscoveredProjectMcpToolset {
  installed: InstalledToolset;
  definition: NormalizedMcpServer;
}

const MAX_ENV_FILE_BYTES = 1024 * 1024;

/**
 * Parse the two broadly-used MCP client configuration envelopes:
 *
 * - VS Code workspace config: `{ "servers": { ... } }`
 * - Claude/Cursor/plugin config: `{ "mcpServers": { ... } }`
 *
 * A single `code --add-mcp` style object (`{name, command/url, ...}`) is
 * accepted too. JSON-with-comments and trailing commas are supported because
 * workspace config files are commonly edited as JSONC.
 */
export function parseMcpConfigText(text: string): ParsedMcpConfig {
  let root: unknown;
  try {
    root = JSON.parse(jsoncToJson(text.replace(/^\uFEFF/, '')));
  } catch (error) {
    throw new Error(`Invalid MCP JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(root)) throw new Error('MCP configuration must be a JSON object');

  const warnings: CustomMcpImportWarning[] = [];
  const candidates: Array<[string, unknown]> = [];
  if (isRecord(root.mcpServers)) candidates.push(...Object.entries(root.mcpServers));
  if (isRecord(root.servers)) candidates.push(...Object.entries(root.servers));
  if (candidates.length === 0 && typeof root.name === 'string') {
    candidates.push([root.name, root]);
  }
  if (candidates.length === 0) {
    throw new Error('Expected a top-level "servers" or "mcpServers" object');
  }

  const servers: NormalizedMcpServer[] = [];
  const seen = new Set<string>();
  for (const [rawName, value] of candidates) {
    const name = rawName.trim();
    if (!name) {
      warnings.push({ message: 'Skipped an MCP server with an empty name' });
      continue;
    }
    if (seen.has(name)) {
      warnings.push({ serverName: name, message: 'Duplicate server name; the first entry wins' });
      continue;
    }
    seen.add(name);
    try {
      const parsed = normalizeServer(name, value);
      if (parsed === null) {
        warnings.push({ serverName: name, message: 'Server is disabled and was skipped' });
        continue;
      }
      const unresolvedInput = firstInputPlaceholder(parsed);
      if (unresolvedInput) {
        warnings.push({
          serverName: name,
          message: `Uses unsupported input variable \${input:${unresolvedInput}}; replace it with an environment variable or literal value`,
        });
        continue;
      }
      servers.push(parsed);
    } catch (error) {
      warnings.push({
        serverName: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (servers.length === 0 && warnings.length > 0) {
    throw new Error(`No importable MCP servers. ${warnings.map((w) => w.message).join('; ')}`);
  }
  return { servers, warnings };
}

/** Discover and normalize approved project-local MCP configurations. */
export async function discoverProjectMcpToolsets(
  workspaceDir: string,
  projectId: string,
): Promise<{ toolsets: DiscoveredProjectMcpToolset[]; warnings: CustomMcpImportWarning[] }> {
  const toolsets: DiscoveredProjectMcpToolset[] = [];
  const warnings: CustomMcpImportWarning[] = [];
  // Gezel-specific config wins over VS Code, which wins over the common
  // root-level `.mcp.json`, when the same server name appears in several.
  const seenNames = new Set<string>();

  for (const relativePath of PROJECT_MCP_CONFIG_PATHS) {
    const absolutePath = join(workspaceDir, relativePath);
    let text: string;
    let modifiedAt: string;
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.size > 2 * 1024 * 1024) {
        warnings.push({ message: `${relativePath} exceeds the 2 MB MCP config limit` });
        continue;
      }
      text = await readFile(absolutePath, 'utf8');
      modifiedAt = fileStat.mtime.toISOString();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      warnings.push({
        message: `Could not read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    let parsed: ParsedMcpConfig;
    try {
      parsed = parseMcpConfigText(text);
    } catch (error) {
      warnings.push({
        message: `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    warnings.push(
      ...parsed.warnings.map((warning) => ({
        ...warning,
        message: `${relativePath}: ${warning.message}`,
      })),
    );
    for (const definition of parsed.servers) {
      if (seenNames.has(definition.name)) {
        warnings.push({
          serverName: definition.name,
          message: `${relativePath}: overridden by a higher-priority project MCP config`,
        });
        continue;
      }
      seenNames.add(definition.name);
      const toolsetId = customMcpToolsetId(
        { kind: 'project', projectId },
        definition.name,
        relativePath,
      );
      const runtime: CustomMcpRuntime = {
        kind: 'custom-mcp',
        serverName: definition.name,
        transport: definition.transport,
        source: { kind: 'project-file', relativePath },
        args: [],
        envKeys: [],
        headerKeys: [],
      };
      toolsets.push({
        installed: {
          toolsetId,
          sourceId: 'project-mcp',
          version: 'custom',
          installedAt: modifiedAt,
          runtime,
        },
        definition,
      });
    }
  }

  return { toolsets, warnings };
}

/** Stable, scope-qualified id so imported credentials never collide. */
export function customMcpToolsetId(
  scope: ToolsetsScope,
  serverName: string,
  source = 'imported',
): string {
  const scopeKey =
    scope.kind === 'shared'
      ? 'shared'
      : scope.kind === 'system'
        ? 'system'
        : scope.kind === 'project'
          ? `project:${scope.projectId}`
          : `gezel:${scope.gezelId}`;
  const digest = createHash('sha256')
    .update(`${scopeKey}\0${source}\0${serverName}`)
    .digest('hex')
    .slice(0, 16);
  return `custom.${digest}`;
}

export function importedRuntimeFor(
  definition: NormalizedMcpServer,
  sourceName?: string,
): CustomMcpRuntime {
  return {
    kind: 'custom-mcp',
    serverName: definition.name,
    transport: definition.transport,
    source: {
      kind: 'imported',
      ...(sourceName?.trim() ? { sourceName: sourceName.trim() } : {}),
    },
    ...(definition.command ? { command: definition.command } : {}),
    args: definition.args,
    ...(definition.cwd ? { cwd: definition.cwd } : {}),
    ...(definition.envFile ? { envFile: definition.envFile } : {}),
    ...(definition.url ? { url: definition.url } : {}),
    envKeys: Object.keys(definition.env),
    headerKeys: Object.keys(definition.headers),
  };
}

export function customMcpSecretField(kind: 'env' | 'header', name: string): string {
  return `${kind}:${name}`;
}

/** Persist imported env/header values in SecretStore, never toolsets.json. */
export async function storeImportedMcpSecrets(
  secrets: SecretStore,
  toolsetId: string,
  definition: NormalizedMcpServer,
): Promise<void> {
  const nextFields = new Set<string>();
  for (const [name, value] of Object.entries(definition.env)) {
    const fieldId = customMcpSecretField('env', name);
    nextFields.add(fieldId);
    await secrets.set({ kind: 'toolset', toolsetId, fieldId }, value);
  }
  for (const [name, value] of Object.entries(definition.headers)) {
    const fieldId = customMcpSecretField('header', name);
    nextFields.add(fieldId);
    await secrets.set({ kind: 'toolset', toolsetId, fieldId }, value);
  }
  for (const oldField of await secrets.listForToolset(toolsetId)) {
    if (!nextFields.has(oldField)) {
      await secrets.delete({ kind: 'toolset', toolsetId, fieldId: oldField });
    }
  }
}

export async function deleteImportedMcpSecrets(
  secrets: SecretStore,
  toolsetId: string,
): Promise<void> {
  for (const fieldId of await secrets.listForToolset(toolsetId)) {
    await secrets.delete({ kind: 'toolset', toolsetId, fieldId });
  }
}

/**
 * Resolve an imported custom runtime into a live bridge spec. Project-file
 * definitions use the sibling function directly because their values remain
 * in the project-owned file.
 */
export async function resolveImportedMcpRuntime(opts: {
  runtime: CustomMcpRuntime;
  toolsetId: string;
  secrets: SecretStore;
  workspaceDir: string;
  knownSecretValues: Set<string>;
}): Promise<McpServerSpec> {
  if (opts.runtime.source.kind !== 'imported') {
    throw new Error('project-file MCP runtimes must be resolved from their live definition');
  }
  const env: Record<string, string> = {};
  for (const name of opts.runtime.envKeys) {
    const value = await opts.secrets.get({
      kind: 'toolset',
      toolsetId: opts.toolsetId,
      fieldId: customMcpSecretField('env', name),
    });
    if (value === null) throw new Error(`missing imported environment value "${name}"`);
    env[name] = value;
    if (value) opts.knownSecretValues.add(value);
  }
  const headers: Record<string, string> = {};
  for (const name of opts.runtime.headerKeys) {
    const value = await opts.secrets.get({
      kind: 'toolset',
      toolsetId: opts.toolsetId,
      fieldId: customMcpSecretField('header', name),
    });
    if (value === null) throw new Error(`missing imported HTTP header "${name}"`);
    headers[name] = value;
    if (value) opts.knownSecretValues.add(value);
  }
  return resolveMcpDefinition(
    {
      name: opts.runtime.serverName,
      transport: opts.runtime.transport,
      ...(opts.runtime.command ? { command: opts.runtime.command } : {}),
      args: opts.runtime.args,
      ...(opts.runtime.cwd ? { cwd: opts.runtime.cwd } : {}),
      ...(opts.runtime.envFile ? { envFile: opts.runtime.envFile } : {}),
      env,
      ...(opts.runtime.url ? { url: opts.runtime.url } : {}),
      headers,
    },
    {
      workspaceDir: opts.workspaceDir,
      knownSecretValues: opts.knownSecretValues,
    },
  );
}

/** Expand workspace/env variables and construct the provider-neutral spec. */
export async function resolveMcpDefinition(
  definition: NormalizedMcpServer,
  opts: { workspaceDir: string; knownSecretValues: Set<string> },
): Promise<McpServerSpec> {
  const fileEnv = definition.envFile
    ? await readEnvFile(definition.envFile, opts.workspaceDir)
    : {};
  const expansionEnv: Record<string, string | undefined> = {
    ...process.env,
    ...fileEnv,
  };
  const inlineEnv: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(definition.env)) {
    const value = expandMcpVariables(rawValue, opts.workspaceDir, {
      ...expansionEnv,
      ...inlineEnv,
    });
    inlineEnv[name] = value;
    expansionEnv[name] = value;
  }
  const env = { ...fileEnv, ...inlineEnv };
  for (const value of Object.values(env)) {
    if (value) opts.knownSecretValues.add(value);
  }

  if (definition.transport === 'stdio') {
    if (!definition.command) throw new Error(`MCP server "${definition.name}" has no command`);
    const cwd = definition.cwd
      ? expandMcpVariables(definition.cwd, opts.workspaceDir, expansionEnv)
      : opts.workspaceDir;
    return {
      kind: 'stdio',
      command: expandMcpVariables(definition.command, opts.workspaceDir, expansionEnv),
      args: definition.args.map((arg) => expandMcpVariables(arg, opts.workspaceDir, expansionEnv)),
      env,
      cwd: isAbsolute(cwd) ? cwd : resolve(opts.workspaceDir, cwd),
    };
  }

  if (!definition.url) throw new Error(`MCP server "${definition.name}" has no URL`);
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(definition.headers)) {
    const value = expandMcpVariables(rawValue, opts.workspaceDir, expansionEnv);
    headers[name] = value;
    if (value) opts.knownSecretValues.add(value);
  }
  const url = expandMcpVariables(definition.url, opts.workspaceDir, expansionEnv);
  // Validate after expansion so `${env:MCP_URL}` is accepted by the parser
  // but still fails clearly if the environment provides a malformed URL.
  new URL(url);
  return {
    kind: 'http',
    transport: definition.transport,
    url,
    headers,
  };
}

function normalizeServer(name: string, raw: unknown): NormalizedMcpServer | null {
  if (!isRecord(raw)) throw new Error('Server definition must be an object');
  if (raw.disabled === true || raw.enabled === false) return null;

  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  const hasCommand = typeof raw.command === 'string' && raw.command.trim().length > 0;
  const hasUrl = typeof raw.url === 'string' && raw.url.trim().length > 0;
  const httpType = type === 'http' || type === 'sse' || type === 'streamable-http';
  const stdioType = type === undefined || type === 'stdio' || type === 'local';
  if (httpType || (type === undefined && !hasCommand && hasUrl)) {
    if (!hasUrl) throw new Error('HTTP MCP server requires a URL');
    return {
      name,
      transport: type === 'sse' ? 'sse' : 'streamable-http',
      args: [],
      env: {},
      url: raw.url as string,
      headers: stringRecord(raw.headers, 'headers'),
    };
  }
  if (!stdioType) throw new Error(`Unsupported MCP server type "${String(raw.type)}"`);
  if (!hasCommand) throw new Error('stdio MCP server requires a command');
  const args = raw.args === undefined ? [] : stringArray(raw.args, 'args');
  return {
    name,
    transport: 'stdio',
    command: raw.command as string,
    args,
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.envFile === 'string' ? { envFile: raw.envFile } : {}),
    env: stringRecord(raw.env, 'env'),
    headers: {},
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`"${field}" must be an object`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`"${field}.${key}" must be a string, number, or boolean`);
    }
    out[key] = String(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstInputPlaceholder(definition: NormalizedMcpServer): string | null {
  const values = [
    definition.command,
    ...definition.args,
    definition.cwd,
    definition.envFile,
    ...Object.values(definition.env),
    definition.url,
    ...Object.values(definition.headers),
  ];
  for (const value of values) {
    const match = value?.match(/\$\{input:([^}]+)\}/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function expandMcpVariables(
  value: string,
  workspaceDir: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (_whole, expression: string) => {
    if (expression === 'workspaceFolder') return workspaceDir;
    if (expression === 'workspaceFolderBasename') return basename(workspaceDir);
    if (expression === 'userHome') return homedir();
    if (expression === 'pathSeparator' || expression === '/') return sep;
    if (expression.startsWith('input:')) {
      throw new Error(`unresolved MCP input variable "\${${expression}}"`);
    }
    const envName = expression.startsWith('env:') ? expression.slice(4) : expression;
    const fallbackAt = envName.indexOf(':-');
    const key = fallbackAt >= 0 ? envName.slice(0, fallbackAt) : envName;
    const fallback = fallbackAt >= 0 ? envName.slice(fallbackAt + 2) : undefined;
    const resolved = env[key];
    if (resolved !== undefined && resolved !== '') return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error(`environment variable "${key}" is not set`);
  });
}

async function readEnvFile(rawPath: string, workspaceDir: string): Promise<Record<string, string>> {
  const expandedPath = expandMcpVariables(rawPath, workspaceDir, process.env);
  const path = isAbsolute(expandedPath) ? expandedPath : resolve(workspaceDir, expandedPath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`MCP envFile is not a file: ${path}`);
  if (info.size > MAX_ENV_FILE_BYTES) throw new Error(`MCP envFile exceeds 1 MB: ${path}`);
  const text = await readFile(path, 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const equals = body.indexOf('=');
    if (equals <= 0) continue;
    const key = body.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Minimal JSONC normalizer: removes comments and trailing commas safely. */
function jsoncToJson(input: string): string {
  let output = '';
  let inString = false;
  let quote = '"';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        output += '  ';
        i += 1;
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      i += 1;
      continue;
    }
    output += char;
  }

  // JSON proper does not accept single-quoted strings. We intentionally do
  // not translate them: MCP JSONC is still JSON, not JSON5.
  return removeTrailingCommas(output);
}

function removeTrailingCommas(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char !== ',') {
      output += char;
      continue;
    }
    let lookahead = i + 1;
    while (lookahead < input.length && /\s/.test(input[lookahead]!)) lookahead += 1;
    if (input[lookahead] === '}' || input[lookahead] === ']') continue;
    output += char;
  }
  return output;
}
