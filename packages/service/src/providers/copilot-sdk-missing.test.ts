import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CopilotProvider } from './copilot.js';

/**
 * The Copilot SDK is an on-demand system toolset, so "not installed" is a
 * routine state, not a broken one. What the user sees for it has to be
 * actionable — and `isActionable` is load-bearing, because
 * `ChatManager.ensureProvider` rewrites anything without that marker into
 * "check your credentials", which points at the wrong problem entirely.
 */
describe('CopilotProvider.initialize with no SDK on disk', () => {
  it('reports an actionable install prompt rather than ERR_MODULE_NOT_FOUND', async () => {
    const provider = new CopilotProvider({
      sdkEntryPath: join(tmpdir(), 'gezel-copilot-absent', 'dist', 'cjs', 'index.js'),
    });

    await expect(provider.initialize()).rejects.toThrow(/Settings → GitHub Copilot/);

    const err = await provider.initialize().catch((e: unknown) => e);
    expect((err as { isActionable?: boolean }).isActionable).toBe(true);
    expect((err as Error).message).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
});
