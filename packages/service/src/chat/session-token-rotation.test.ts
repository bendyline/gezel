import { mkdtemp, rm } from 'node:fs/promises';
/**
 * Repro for the "MCP bridge 401 unauthorized" regression
 * introduced by the "Ephemeral tokens" change (commit c5d9e9c5).
 *
 * Mechanism: a gezel's MCP bridge is spawned with a per-session ephemeral
 * token minted via `issueSessionToken` (TokenStore.issueSession), baked
 * into the child's `GEZEL_TOKEN` env. But `issueSession` UPSERTS — a
 * second mint for the same `appId` deletes the prior token. And the token
 * mint is a side effect of `buildSessionOpts`, which the post-spawn
 * `refreshSystemPromptForLiveTools` → `recomputeSystemMessage` re-runs
 * purely to recompute the system-message string. So:
 *   1. send() builds opts (mint T1) → bridge spawns holding T1
 *   2. post-spawn refresh re-runs buildSessionOpts (mint T2) → T1 deleted
 *   3. the live bridge's first /api call uses T1 → 401 unauthorized
 *
 * Two layers of coverage:
 *   A. TokenStore primitive — the upsert invalidates the prior token.
 *   B. End-to-end — a scripted bridge tool call under a production-wired
 *      ChatManager (issueSessionToken set) fails to authenticate.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { createTokenStore } from '../http/token-store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const require = createRequire(import.meta.url);

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

describe('TokenStore.issueSession — rotation invalidates a live bridge token (primitive)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-tokrot-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('re-issuing the same appId must NOT invalidate the token a live bridge already holds', async () => {
    const store = await createTokenStore({ home, rootToken: 'root-test-token' });
    const r1 = store.issueSession({
      appId: 'session:s1',
      projectId: 'default',
      gezelId: 'kenji',
      team: true,
    });
    // A bridge spawned now holds r1.token in its env.
    expect(store.lookup(r1.token)).not.toBeNull();

    // buildSessionOpts re-runs (post-spawn prompt refresh) → second mint
    // for the SAME session appId. The live bridge is NOT re-spawned, so it
    // still holds r1.token.
    const r2 = store.issueSession({
      appId: 'session:s1',
      projectId: 'default',
      gezelId: 'kenji',
      team: true,
    });

    // The fix's contract: the live bridge's token stays valid across a
    // re-mint (idempotent get-or-create). Pre-fix this FAILS — the upsert
    // deletes r1.token, so the bridge's next /api call 401s.
    expect(store.lookup(r1.token), 'bridge token invalidated by re-mint → 401').not.toBeNull();
    expect(r2.token).toBe(r1.token);
    // Scope binding may legitimately update in place; the token value must not.
    expect(store.lookup(r1.token)?.projectId).toBe('default');
  });
});

describe('ChatManager bridge auth — production-wired issueSessionToken (end-to-end)', () => {
  let svc: RunningService;
  let home: string;
  let store: Store;
  let manager: ChatManager;
  let mock: MockProvider;
  const mintedSessionTokens: string[] = [];

  beforeEach(async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    home = await mkdtemp(join(tmpdir(), 'gezel-bridge-auth-'));
    svc = await startService({ home });
    store = svc.context.store;
    mock = new MockProvider({ name: 'copilot' });
    mintedSessionTokens.length = 0;
    manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => svc.port,
      getToken: () => svc.context.token,
      getCert: () => svc.cert?.certPem ?? null,
      home,
      providers: [['copilot', mock]],
      catalog: svc.context.catalog,
      secrets: svc.context.secrets,
      // Wire the ephemeral session-token minter exactly as service.ts does.
      // Record every minted token so the test can prove the bridge's token
      // survives the post-spawn refresh.
      issueSessionToken: (input) => {
        const rec = svc.context.tokenStore.issueSession(input);
        mintedSessionTokens.push(rec.token);
        return rec;
      },
      revokeSessionToken: (appId) => svc.context.tokenStore.revokeSession(appId),
    });
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.writeConfig({ toolFilterMode: 'never' });
  }, 30_000);

  afterEach(async () => {
    await manager?.shutdown();
    await svc?.stop();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    delete process.env.GEZEL_MOCK_PROVIDER;
  });

  it('a scripted bridge tool call authenticates after the post-spawn prompt refresh', async () => {
    const mcpPath = require.resolve('@bendyline/gezel-mcp/dist/server.js');
    expect(mcpPath).toBeTruthy();

    const session = await manager.createSession({ gezelId: 'ada' });

    // The token mint is lazy — it happens inside buildSessionOpts during
    // send() (and again in the post-spawn refresh), so drive a real turn.
    mock.scriptToolCalls([
      {
        name: 'write_document',
        arguments: { path: 'from-bridge/hello.md', content: '# via bridge\n' },
      },
    ]);
    mock.script('done');
    await manager.send(session.id, 'Write the doc.');

    // Every session token minted for this session — any of which a live
    // bridge could be holding — must still resolve. Pre-fix, the post-spawn
    // refresh re-mints and the upsert deletes the bridge's first token.
    expect(mintedSessionTokens.length).toBeGreaterThan(0);
    for (const tok of mintedSessionTokens) {
      expect(
        svc.context.tokenStore.lookup(tok),
        'a session token handed to a spawned bridge was invalidated by a later re-mint',
      ).not.toBeNull();
    }

    // End-to-end: the tool call must have authenticated through the /api
    // back-channel and written the doc (pre-fix it 401s → no file).
    const doc = await store.readDocument('from-bridge/hello.md');
    expect(doc, 'write_document did not land — bridge tool call failed to authenticate').not.toBe(
      null,
    );
    expect(doc ?? '').toContain('via bridge');
  }, 60_000);
});
