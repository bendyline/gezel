/**
 * The portable host's tool surface against the desktop MCP server's.
 *
 * Every tool a phone offers must be a desktop tool that is always
 * registered and model-facing, and the two hosts' input schemas must
 * accept and reject the same arguments. The second guarantee is a ratchet:
 * `KNOWN_SCHEMA_DIVERGENCE` lists the pairs that still disagree, and a
 * change may only shrink it.
 */
import { TOOL_CALL_FIXTURES } from '@bendyline/gezel';
import { portableToolInputSchema, portableToolNames } from '@bendyline/gezel/runtime';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { unavailableToolsForPlatform } from './platform-tool-availability.js';
import { CANONICAL_TOOL_NAMES, TOOL_REGISTRY } from './tool-inventory.js';

interface RegisteredTool {
  inputSchema?: z.ZodTypeAny;
}
interface InspectableServer {
  _registeredTools: Record<string, RegisteredTool>;
}

async function loadServer(): Promise<InspectableServer> {
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
  }))
    vi.stubEnv(k, v);
  vi.resetModules();
  const mod = await import('./server.js');
  return mod.server as unknown as InspectableServer;
}

/**
 * Fixture pairs whose two schemas still answer differently. The list emptied
 * when the hosts began sharing their input contracts; nothing may add to it.
 */
const KNOWN_SCHEMA_DIVERGENCE: readonly string[] = [];

let server: InspectableServer;
beforeAll(async () => {
  server = await loadServer();
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('portable tools against the MCP inventory', () => {
  it('offers only tools the desktop always registers and shows the model', () => {
    const canonical = new Set<string>(CANONICAL_TOOL_NAMES as readonly string[]);
    const registry = TOOL_REGISTRY as Record<
      string,
      { registration: string; modelFacing: boolean }
    >;
    const problems: string[] = [];
    for (const name of portableToolNames()) {
      if (!canonical.has(name)) problems.push(`${name}: not a desktop tool`);
      else if (registry[name]?.registration !== 'always')
        problems.push(`${name}: conditional on desktop`);
      else if (!registry[name]?.modelFacing) problems.push(`${name}: not model-facing on desktop`);
    }
    expect(problems).toEqual([]);
  });

  it('has a fixture pair for every portable tool', () => {
    const covered = new Set(TOOL_CALL_FIXTURES.map((fixture) => fixture.tool));
    expect([...portableToolNames()].filter((name) => !covered.has(name))).toEqual([]);
  });

  it('registers every portable field on the desktop, so a call the phone accepts is never unknown to the daemon', () => {
    const unavailable = new Set(unavailableToolsForPlatform(process.platform));
    const problems: string[] = [];
    for (const name of portableToolNames()) {
      if (unavailable.has(name)) continue;
      const portable = portableToolInputSchema(name) as z.ZodObject | undefined;
      const desktop = server._registeredTools[name]?.inputSchema as z.ZodObject | undefined;
      if (!portable?.shape || !desktop?.shape) {
        problems.push(`${name}: schema missing`);
        continue;
      }
      for (const key of Object.keys(portable.shape))
        if (!(key in desktop.shape)) problems.push(`${name}.${key}: portable only`);
    }
    expect(problems).toEqual([]);
  });

  it('accepts and rejects the same arguments on both hosts, except the known ratchet', () => {
    const unavailable = new Set(unavailableToolsForPlatform(process.platform));
    const divergent: string[] = [];
    for (const fixture of TOOL_CALL_FIXTURES) {
      if (unavailable.has(fixture.tool)) continue;
      const portable = portableToolInputSchema(fixture.tool);
      const desktop = server._registeredTools[fixture.tool]?.inputSchema;
      expect(portable, `${fixture.tool} portable schema`).toBeDefined();
      expect(desktop, `${fixture.tool} desktop schema`).toBeDefined();
      const p = portable!.safeParse(fixture.args).success;
      const d = desktop!.safeParse(fixture.args).success;
      if (p !== d) divergent.push(`${fixture.tool} [${fixture.expect}] portable=${p} desktop=${d}`);
    }
    expect(divergent.sort()).toEqual([...KNOWN_SCHEMA_DIVERGENCE].sort());
  });
});
