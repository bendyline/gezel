/**
 * Tool inventory & contract tests for the gezel-mcp server.
 *
 * Loads server.ts in a sandboxed env (`GEZEL_MCP_NO_MAIN=1` so the
 * stdio transport never starts), then introspects the McpServer's
 * `_registeredTools` map to make three guarantees:
 *
 *   1. Inventory — every name in `tool-inventory.ts` is registered, no
 *      surprise extras present. A rename or accidental deletion in
 *      `server.ts` fails the test loudly.
 *   2. Schema shape — every registered tool exposes a Zod input schema
 *      that is at least introspectable. Catches a tool registered with
 *      a non-Zod arg (which the OpenAI bridge's JSON-schema translator
 *      would silently turn into `{ type: 'object', properties: {} }`,
 *      letting the model send any garbage).
 *   3. Conditional registration — `request_tool_permission` only appears
 *      when `GEZEL_PERMISSION_PROMPT=1`, and only then. Other gated
 *      tools follow the same pattern via `CONDITIONALLY_REGISTERED_TOOLS`.
 *   4. Alias dispatch — legacy spellings from `RENAMED_TOOLS` stay
 *      callable through the wrapped `tools/call` handler without ever
 *      being registered (so they never appear in `tools/list`), and
 *      `GEZEL_MCP_TOOL_NAMING=legacy` flips the advertised spellings.
 *
 * The `_registeredTools` field on McpServer and the `_requestHandlers`
 * map on the underlying Server are private but stable across the SDK
 * 1.x line — see [mcp.d.ts]. If the SDK ever moves them, this test
 * gives us a single failure point to update rather than relying on each
 * tool's hand-rolled fixture.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { unavailableToolsForPlatform } from './platform-tool-availability.js';
import { ALWAYS_REGISTERED_TOOLS, CONDITIONALLY_REGISTERED_TOOLS } from './tool-inventory.js';

interface RegisteredTool {
  description?: string;
  inputSchema?: z.ZodTypeAny;
  handler: (...args: unknown[]) => unknown;
}

interface InspectableServer {
  _registeredTools: Record<string, RegisteredTool>;
  server: {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
}

function callToolHandler(server: InspectableServer) {
  const handler = server.server._requestHandlers.get('tools/call');
  expect(handler, 'tools/call handler installed').toBeDefined();
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = (await handler!(
      { method: 'tools/call', params: { name, arguments: args } },
      {},
    )) as { content?: Array<{ text?: string }> };
    return (result.content ?? []).map((c) => c.text ?? '').join(' ');
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const platformUnavailableTools = new Set(unavailableToolsForPlatform(process.platform));
const platformAvailableAlwaysRegisteredTools = ALWAYS_REGISTERED_TOOLS.filter(
  (name) => !platformUnavailableTools.has(name),
);

function propNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function stringLiteralText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function readBuiltinToolsetGroups(): Map<string, string[]> {
  const sourcePath = resolve(__dirname, '../../catalog/src/builtin-toolsets.ts');
  const text = readFileSync(sourcePath, 'utf8');
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  let builtinArray: ts.ArrayLiteralExpression | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'BUILTIN_TOOLSETS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      builtinArray = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (!builtinArray) {
    throw new Error(`Could not find BUILTIN_TOOLSETS array in ${sourcePath}`);
  }

  const groups = new Map<string, string[]>();
  for (const element of builtinArray.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    let id: string | undefined;
    const tools: string[] = [];
    for (const prop of element.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propNameText(prop.name);
      if (name === 'id') {
        id = stringLiteralText(prop.initializer);
      } else if (name === 'tools' && ts.isArrayLiteralExpression(prop.initializer)) {
        for (const tool of prop.initializer.elements) {
          const value = stringLiteralText(tool);
          if (value) tools.push(value);
        }
      }
    }
    if (id) groups.set(id, tools);
  }
  return groups;
}

async function loadServer(env: Record<string, string> = {}): Promise<InspectableServer> {
  // Belt-and-suspenders: even with GEZEL_MCP_NO_MAIN=1 the module still
  // constructs a GezelClient at top level. A real fetch attempt would
  // need a server to talk to; we stub fetch globally so any accidental
  // network call during registration fails loudly rather than hangs.
  vi.stubGlobal('fetch', () => {
    throw new Error('fetch should not be called during MCP tool registration');
  });
  for (const [k, v] of Object.entries({
    GEZEL_MCP_NO_MAIN: '1',
    GEZEL_BASE_URL: 'http://127.0.0.1:0',
    GEZEL_TOKEN: 'test-token',
    GEZEL_AGENT_ID: 'test-agent',
    GEZEL_PROJECT_ID: 'test-project',
    GEZEL_SESSION_ID: 'test-session',
    GEZEL_HOME: '/tmp/gezel-mcp-test',
    ...env,
  })) {
    vi.stubEnv(k, v);
  }
  // Bust the module cache so each call sees fresh registrations under
  // the env we just stubbed.
  vi.resetModules();
  const mod = await import('./server.js');
  return mod.server as unknown as InspectableServer;
}

describe('MCP tool inventory', () => {
  let server: InspectableServer;

  beforeAll(async () => {
    server = await loadServer();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('registers every platform-available tool in the always-registered list', () => {
    const registered = new Set(Object.keys(server._registeredTools));
    const missing = platformAvailableAlwaysRegisteredTools.filter((name) => !registered.has(name));
    expect(missing, `missing tools: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not register any unexpected tools without env gating', () => {
    const registered = new Set(Object.keys(server._registeredTools));
    const expected = new Set<string>(ALWAYS_REGISTERED_TOOLS);
    const extras = Array.from(registered).filter((name) => !expected.has(name));
    expect(
      extras,
      `unexpected tools registered without inventory entry: ${extras.join(', ')}`,
    ).toEqual([]);
  });

  it('registers exactly the documented number of tools', () => {
    expect(Object.keys(server._registeredTools)).toHaveLength(
      platformAvailableAlwaysRegisteredTools.length,
    );
  });
});

describe('MCP builtin toolset grouping', () => {
  it('assigns every always-registered tool to a built-in toolset group', () => {
    const groups = readBuiltinToolsetGroups();
    const grouped = new Set(Array.from(groups.values()).flat());
    const missing = ALWAYS_REGISTERED_TOOLS.filter((name) => !grouped.has(name));
    expect(
      missing,
      `always-registered tools missing from BUILTIN_TOOLSETS: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('does not list unknown tools in built-in toolset groups', () => {
    const groups = readBuiltinToolsetGroups();
    const known = new Set<string>([
      ...ALWAYS_REGISTERED_TOOLS,
      ...Object.keys(CONDITIONALLY_REGISTERED_TOOLS),
    ]);
    const extras = Array.from(groups.entries()).flatMap(([groupId, tools]) =>
      tools.filter((toolName) => !known.has(toolName)).map((toolName) => `${groupId}:${toolName}`),
    );
    expect(extras, `BUILTIN_TOOLSETS names unknown tools: ${extras.join(', ')}`).toEqual([]);
  });
});

describe('MCP tool contracts', () => {
  let server: InspectableServer;

  beforeAll(async () => {
    server = await loadServer();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('every tool exposes a Zod input schema', () => {
    const offenders: string[] = [];
    for (const [name, def] of Object.entries(server._registeredTools)) {
      const schema = def.inputSchema;
      if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
        offenders.push(name);
      }
    }
    expect(offenders, `tools missing a Zod input schema: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every tool has a non-empty description', () => {
    const offenders: string[] = [];
    for (const [name, def] of Object.entries(server._registeredTools)) {
      const desc = def.description?.trim() ?? '';
      if (desc.length === 0) offenders.push(name);
    }
    expect(
      offenders,
      `tools without a description (the model relies on it): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every tool handler is a function', () => {
    for (const [name, def] of Object.entries(server._registeredTools)) {
      expect(typeof def.handler, `${name}.handler`).toBe('function');
    }
  });
});

describe('MCP conditional tool registration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  for (const [name, gate] of Object.entries(CONDITIONALLY_REGISTERED_TOOLS)) {
    it(`registers '${name}' only when ${gate.envVar}=${gate.envValue}`, async () => {
      const off = await loadServer({ [gate.envVar]: '' });
      expect(Object.keys(off._registeredTools)).not.toContain(name);

      const on = await loadServer({
        [gate.envVar]: gate.envValue === '*' ? 'test-context' : gate.envValue,
      });
      expect(Object.keys(on._registeredTools)).toContain(name);
    });
  }
});

describe('MCP tool exclusion', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('GEZEL_MCP_EXCLUDE strips tools from registration', async () => {
    const server = await loadServer({
      GEZEL_MCP_EXCLUDE: 'read_file,write_file,list_dir',
    });
    const registered = new Set(Object.keys(server._registeredTools));
    expect(registered.has('read_file')).toBe(false);
    expect(registered.has('write_file')).toBe(false);
    expect(registered.has('list_dir')).toBe(false);
    // Sibling tools still register.
    expect(registered.has('stat')).toBe(true);
    expect(registered.has('make_dir')).toBe(true);
  });

  it('GEZEL_MCP_EXCLUDE accepts legacy spellings (canonicalized matching)', async () => {
    const server = await loadServer({
      GEZEL_MCP_EXCLUDE: 'readFile,writeFile,readdir',
    });
    const registered = new Set(Object.keys(server._registeredTools));
    expect(registered.has('read_file')).toBe(false);
    expect(registered.has('write_file')).toBe(false);
    expect(registered.has('list_dir')).toBe(false);
    expect(registered.has('stat')).toBe(true);
  });

  it('GEZEL_MCP_ALLOW restricts registration to the named tools', async () => {
    const server = await loadServer({
      GEZEL_MCP_ALLOW: 'list_tasks,read_task_notes',
    });
    const registered = new Set(Object.keys(server._registeredTools));
    expect(registered.has('list_tasks')).toBe(true);
    expect(registered.has('read_task_notes')).toBe(true);
    expect(registered.has('write_file')).toBe(false);
    expect(registered.has('ask_specialist')).toBe(false);
  });

  it('GEZEL_MCP_EXCLUDE wins over GEZEL_MCP_ALLOW', async () => {
    const server = await loadServer({
      GEZEL_MCP_ALLOW: 'list_tasks,read_task_notes',
      GEZEL_MCP_EXCLUDE: 'read_task_notes',
    });
    const registered = new Set(Object.keys(server._registeredTools));
    expect(registered.has('list_tasks')).toBe(true);
    expect(registered.has('read_task_notes')).toBe(false);
  });
});

describe('MCP tool input schemas', () => {
  let server: InspectableServer;

  beforeAll(async () => {
    server = await loadServer();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // A representative sample across tool groups. Every entry asserts the
  // documented happy-path input parses, and where an obviously required
  // field is missing, parse fails. Full per-tool behavioral coverage
  // belongs in the per-group test files; this is the contract pin.
  const samples: Array<{
    tool: string;
    valid: Record<string, unknown>;
    invalid?: Record<string, unknown>;
  }> = [
    { tool: 'search_memory', valid: { query: 'hello' }, invalid: {} },
    {
      tool: 'save_memory',
      valid: { text: 'a fact', scope: 'gezel', kind: 'pref' },
      invalid: { text: 'a' },
    },
    { tool: 'list_memories', valid: { scope: 'project' }, invalid: {} },
    { tool: 'list_dir', valid: { path: 'src' }, invalid: { path: 123 } },
    { tool: 'read_file', valid: { path: 'README.md' }, invalid: {} },
    { tool: 'write_file', valid: { path: 'a.txt', content: 'hi' }, invalid: { path: 'a.txt' } },
    { tool: 'stat', valid: { path: 'package.json' }, invalid: {} },
    { tool: 'delete_path', valid: { path: 'tmp.txt' }, invalid: {} },
    { tool: 'make_dir', valid: { path: 'newdir' }, invalid: {} },
    {
      tool: 'rename',
      valid: { fromPath: 'a', toPath: 'b' },
      invalid: { fromPath: 'a' },
    },
    { tool: 'list_artifacts', valid: {} },
    { tool: 'read_artifact', valid: { path: 'r.md' }, invalid: {} },
    { tool: 'write_artifact', valid: { path: 'r.md', content: 'x' }, invalid: { path: 'r.md' } },
    { tool: 'list_documents', valid: {} },
    { tool: 'list_gezels', valid: {} },
    { tool: 'list_projects', valid: {} },
    { tool: 'list_tasks', valid: {} },
    { tool: 'search_history', valid: {} },
    {
      tool: 'delegate_developer',
      valid: {
        task: 'Write src/producer.ts for the event pipeline.',
        project: 'typescript-event-pipeline',
        expectedDeliverable: { kind: 'file', filePath: 'src/producer.ts' },
      },
      invalid: {},
    },
    {
      tool: 'consult_developer',
      valid: {
        question: 'Which event payload shape should producer.ts emit?',
        project: 'typescript-event-pipeline',
      },
      invalid: {},
    },
  ];

  for (const sample of samples) {
    it(`'${sample.tool}' input schema accepts the documented happy-path payload`, () => {
      const tool = server._registeredTools[sample.tool];
      expect(tool, `tool ${sample.tool} not registered`).toBeDefined();
      const schema = tool!.inputSchema;
      // The MCP SDK wraps the raw shape into a z.object; either way
      // safeParse exists. If the shape is `z.object({...})` the parse
      // applies; if it's a raw shape we wrap before parsing.
      const parser =
        schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function'
          ? (schema as z.ZodTypeAny)
          : z.object(schema as unknown as z.ZodRawShape);
      const result = parser.safeParse(sample.valid);
      expect(result.success, JSON.stringify(result, null, 2)).toBe(true);
    });

    if (sample.invalid !== undefined) {
      it(`'${sample.tool}' input schema rejects an invalid payload`, () => {
        const tool = server._registeredTools[sample.tool];
        const schema = tool!.inputSchema;
        const parser =
          schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function'
            ? (schema as z.ZodTypeAny)
            : z.object(schema as unknown as z.ZodRawShape);
        const result = parser.safeParse(sample.invalid);
        expect(result.success).toBe(false);
      });
    }
  }
});

describe('MCP tool name alias dispatch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // The tool handlers themselves hit the stubbed `fetch` and surface its
  // error as an in-band `isError` result. The SDK ALSO reports unknown
  // tools in-band ("Tool X not found"), so the discriminator is the
  // result text: a dispatched alias reaches a real handler and never
  // says "not found"; an unknown name does.
  it('dispatches legacy spellings to the renamed tools without registering them', async () => {
    const server = await loadServer();
    const registered = new Set(Object.keys(server._registeredTools));
    expect(registered.has('writeFile')).toBe(false);
    expect(registered.has('readdir')).toBe(false);

    const call = callToolHandler(server);
    expect(await call('writeFile', { path: 'a.txt', content: 'hi' })).not.toMatch(/not found/);
    expect(await call('readdir', { path: 'src' })).not.toMatch(/not found/);
    expect(await call('rm', { path: 'tmp.txt' })).not.toMatch(/not found/);
  });

  it('dispatches case/punctuation variants of registered names', async () => {
    const server = await loadServer();
    const call = callToolHandler(server);
    expect(await call('WriteFile', { path: 'a.txt', content: 'hi' })).not.toMatch(/not found/);
    expect(await call('write-file', { path: 'a.txt', content: 'hi' })).not.toMatch(/not found/);
    expect(await call('read_dir', { path: 'src' })).not.toMatch(/not found/);
  });

  it('still reports genuinely unknown tool names as not found', async () => {
    const server = await loadServer();
    const call = callToolHandler(server);
    expect(await call('definitely_not_a_tool', {})).toMatch(/not found/);
  });
});

describe('MCP legacy naming mode (GEZEL_MCP_TOOL_NAMING=legacy)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('advertises the pre-rename spellings for renamed tools only', async () => {
    const server = await loadServer({ GEZEL_MCP_TOOL_NAMING: 'legacy' });
    const registered = new Set(Object.keys(server._registeredTools));
    expect(registered.has('readFile')).toBe(true);
    expect(registered.has('writeFile')).toBe(true);
    expect(registered.has('readdir')).toBe(true);
    expect(registered.has('read_file')).toBe(false);
    expect(registered.has('write_file')).toBe(false);
    expect(registered.has('list_dir')).toBe(false);
    // Never-renamed tools keep their canonical names.
    expect(registered.has('search_memory')).toBe(true);
    expect(registered.has('stat')).toBe(true);
    // 1:1 swap — the surface size is unchanged.
    expect(registered.size).toBe(platformAvailableAlwaysRegisteredTools.length);
  });

  it('dispatches canonical spellings onto the legacy-registered tools', async () => {
    const server = await loadServer({ GEZEL_MCP_TOOL_NAMING: 'legacy' });
    const call = callToolHandler(server);
    expect(await call('write_file', { path: 'a.txt', content: 'hi' })).not.toMatch(/not found/);
    expect(await call('list_dir', { path: 'src' })).not.toMatch(/not found/);
  });
});

describe('MCP dynamic script tools (GEZEL_SCRIPT_TOOLS)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const SPECS = JSON.stringify([
    {
      name: 'record_application',
      description: 'Track a new application in the pipeline.',
      script: 'application-store',
      inputs: {
        type: 'object',
        properties: { company: { type: 'string' } },
        required: ['company'],
      },
      bind: { action: 'record_application' },
    },
    {
      name: 'run_installed_script',
      description: 'collides with a builtin',
      script: 'application-store',
    },
  ]);

  it('registers declared tools with schemas and keeps the builtin on a name collision', async () => {
    const server = await loadServer({ GEZEL_SCRIPT_TOOLS: SPECS });
    const dynamic = server._registeredTools.record_application;
    expect(dynamic).toBeDefined();
    expect(dynamic?.description).toBe('Track a new application in the pipeline.');
    expect(dynamic?.inputSchema).toBeDefined();
    // The colliding spec is skipped; run_installed_script stays the builtin.
    expect(server._registeredTools.run_installed_script?.description).toContain(
      'ALREADY-INSTALLED project script',
    );
  });

  it('does not disturb the frozen inventory contract for builtins', async () => {
    const server = await loadServer({ GEZEL_SCRIPT_TOOLS: SPECS });
    const registered = new Set(Object.keys(server._registeredTools));
    for (const name of platformAvailableAlwaysRegisteredTools) {
      expect(registered.has(name), `missing builtin ${name}`).toBe(true);
    }
    expect(registered.size).toBe(platformAvailableAlwaysRegisteredTools.length + 1);
  });

  it('GEZEL_MCP_EXCLUDE strips a dynamic tool', async () => {
    const server = await loadServer({
      GEZEL_SCRIPT_TOOLS: SPECS,
      GEZEL_MCP_EXCLUDE: 'record_application',
    });
    expect(server._registeredTools.record_application).toBeUndefined();
  });

  it('GEZEL_MCP_ALLOW gates dynamic tools like builtins', async () => {
    const allowed = await loadServer({
      GEZEL_SCRIPT_TOOLS: SPECS,
      GEZEL_MCP_ALLOW: 'record_application,list_scripts',
    });
    expect(allowed._registeredTools.record_application).toBeDefined();

    const filtered = await loadServer({
      GEZEL_SCRIPT_TOOLS: SPECS,
      GEZEL_MCP_ALLOW: 'list_scripts',
    });
    expect(filtered._registeredTools.record_application).toBeUndefined();
  });
});
