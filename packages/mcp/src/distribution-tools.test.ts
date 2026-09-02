/**
 * A store build withholds `npm_install` from the tool schema entirely.
 *
 * Registering it and declining every call would be worse than absent: the
 * model pays the schema cost on every turn, and a model that sees a tool
 * reaches for it — here, repeatedly, against the one capability the build
 * cannot have. The same reasoning already governs the platform-unavailable
 * deny-net tools, and this rides the same exclusion set.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface InspectableServer {
  _registeredTools: Record<string, unknown>;
}

async function loadServer(env: Record<string, string> = {}): Promise<InspectableServer> {
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
    GEZEL_HOME: '/tmp/gezel-mcp-dist-test',
    ...env,
  })) {
    vi.stubEnv(k, v);
  }
  vi.resetModules();
  const mod = await import('./server.js');
  return mod.server as unknown as InspectableServer;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('npm_install under the store distribution profile', () => {
  it('is registered in an ordinary build', async () => {
    const server = await loadServer({ GEZEL_DISTRIBUTION_PROFILE: '' });
    expect(Object.keys(server._registeredTools)).toContain('npm_install');
  });

  it('is withheld in a store build', async () => {
    const server = await loadServer({ GEZEL_DISTRIBUTION_PROFILE: 'store' });
    expect(Object.keys(server._registeredTools)).not.toContain('npm_install');
  });

  it('keeps the tools that operate on packages already present', async () => {
    const server = await loadServer({ GEZEL_DISTRIBUTION_PROFILE: 'store' });
    const registered = Object.keys(server._registeredTools);
    // Nothing about these fetches code; withholding them would cost a store
    // build script-running ability it is entitled to keep.
    expect(registered).toContain('list_packages');
    expect(registered).toContain('run_npx');
    expect(registered).toContain('run_package_script');
  });
});
