/**
 * M3 spike — proves the fake-MCP rail end to end on this machine,
 * deterministically, with no model:
 *
 *   1. `startMockServices` boots the monitor-and-alert book's `alerts`
 *      mcp mock: a real Streamable-HTTP MCP endpoint on loopback HTTPS
 *      with a per-trial self-signed cert.
 *   2. The runtime's local-catalog toolset manifests are written into a
 *      temp GEZEL_HOME (`toolsets/mo/mock-mcp-alerts/…`), the same thing
 *      the runner does before a trial daemon spawns.
 *   3. A real `gezeld` is spawned with `NODE_EXTRA_CA_CERTS` so its MCP
 *      bridge trusts the cert, and `installToolset('mock-mcp-alerts')`
 *      registers the toolset for a created gezel through the ordinary
 *      catalog rail (LocalCatalogSource now serves local toolsets).
 *   4. Proof of connection: `listSessionTools` builds the session's real
 *      bridge pool — the daemon-side StreamableHTTPClientTransport must
 *      initialize against the fake and list its tools. Then
 *      `invokeSessionTool('list_alerts')` round-trips a call and the
 *      mock's request log must show `tools/call:list_alerts`.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx scripts/spike-mock-mcp.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CRAFTBOOK_TEST_FILENAME } from '@bendyline/gezel';
import { discoverOrSpawn, resolveDaemonEntry } from '@bendyline/gezel-client/node';
import { loadCraftbookTestSpecsSync } from '../src/craftbooks/test-spec-loader.ts';
import { mockMcpToolsetId, startMockServices } from '../src/mock/mock-server.ts';

async function main(): Promise<void> {
  const book = loadCraftbookTestSpecsSync().find(
    (entry) => entry.craftbookId === 'monitor-and-alert',
  );
  if (!book) throw new Error(`monitor-and-alert ${CRAFTBOOK_TEST_FILENAME} not found`);
  const mcpMock = book.spec.mocks.find((mock) => mock.kind === 'mcp');
  if (!mcpMock || mcpMock.kind !== 'mcp') throw new Error('monitor-and-alert has no mcp mock');

  const runtime = await startMockServices(book.spec.mocks);
  if (!runtime) throw new Error('no live mock services in the monitor-and-alert spec');
  const home = await mkdtemp(join(tmpdir(), 'gezel-mcp-spike-'));
  const caPath = join(home, 'mock-ca.pem');
  await writeFile(caPath, runtime.caPem, 'utf8');

  // Same write the runner performs: local-catalog toolset manifests into
  // the trial home, before the daemon boots.
  const toolsetFiles = runtime.mcpToolsetFiles();
  if (toolsetFiles.length === 0) throw new Error('mcpToolsetFiles() returned nothing');
  for (const file of toolsetFiles) {
    const target = join(home, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  console.log(`[spike] wrote ${toolsetFiles.length} local-catalog toolset file(s)`);

  let child: { kill(signal: string): void; exitCode: number | null } | undefined;
  try {
    const spawned = await discoverOrSpawn({
      daemonEntry: resolveDaemonEntry(import.meta.url),
      detached: false,
      stdio: 'pipe',
      home,
      env: {
        ...process.env,
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_PORT: '0',
        NODE_EXTRA_CA_CERTS: caPath,
      },
      timeoutMs: 20_000,
    });
    child = spawned.child ?? undefined;
    const client = spawned.client;

    // Installing a non-builtin toolset is gated on allowExternalServices;
    // the trial posture is free (isolated home, loopback fakes only).
    await client.updateConfig({
      securityPolicy: {
        level: 'free',
        allowFileEdits: true,
        allowExternalChat: true,
        allowExternalServices: true,
        allowScriptExecution: true,
        allowAppNetwork: true,
      },
    });

    const project = await client.createProject({ name: 'Mock MCP Spike' });
    const gezel = await client.createGezel({ name: 'Probe', role: 'Developer' });
    const toolsetId = mockMcpToolsetId(mcpMock.id);
    const installed = await client.installToolset(toolsetId, {
      scope: { kind: 'gezel', gezelId: gezel.id },
    });
    console.log(
      `[spike] installed ${toolsetId}@${installed.installed.version} (runtime=${installed.installed.runtime.kind})`,
    );

    const session = await client.createChatSession({ gezelId: gezel.id, projectId: project.id });
    const { tools } = await client.listSessionTools(session.id);
    const names = tools.map((tool) => tool.name);
    for (const declared of mcpMock.tools) {
      if (!names.includes(declared.name)) {
        throw new Error(
          `tool "${declared.name}" missing from session roster (${names.length} tools: ${names.join(', ')})`,
        );
      }
    }
    console.log(`[spike] session roster carries ${mcpMock.tools.map((t) => t.name).join(', ')}`);

    const result = await client.invokeSessionTool(session.id, 'list_alerts', {});
    const parsed = JSON.parse(result.text) as { alerts?: Array<{ id?: string }> };
    if (parsed.alerts?.[0]?.id !== 'AL-7') {
      throw new Error(`unexpected list_alerts result: ${result.text}`);
    }
    const service = runtime.services.get(mcpMock.id);
    const logged = service?.requests.filter((entry) => entry.path === 'tools/call:list_alerts');
    if (!logged || logged.length < 1) {
      throw new Error(
        `mock request log has no tools/call:list_alerts entry: ${JSON.stringify(service?.requests)}`,
      );
    }

    console.log('[spike] PASS — local-catalog toolset install, daemon-side Streamable-HTTP');
    console.log('        bridge connect over the trial CA, tools/list roster, tools/call');
    console.log('        round-trip, and request-log capture.');
    console.log(`[spike] ${mcpMock.id} log: ${JSON.stringify(service?.requests)}`);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await runtime.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[spike] FAIL:', err);
  process.exit(1);
});
