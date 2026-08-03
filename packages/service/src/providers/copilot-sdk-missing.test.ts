import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CopilotProvider } from './copilot.js';

/**
 * The Copilot SDK is an on-demand system toolset, so "not installed" is a
 * routine state, not a broken one. What the user sees for it has to be
 * actionable — and `isActionable` is load-bearing, because
 * `ChatManager.ensureProvider` rewrites anything without that marker into
 * "check your credentials", which points at the wrong problem entirely.
 *
 * The wording also has to match what Settings will actually show. When the
 * install directory exists but won't load (dangling links, truncated tree),
 * "choose Install" strands the user: the Settings card sees the directory,
 * says "Installed", and offers no install button. That state must say
 * "Repair" instead — the card's damaged branch is the affordance it points
 * at.
 */
describe('CopilotProvider.initialize when the SDK fails to load', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-copilot-sdk-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports an actionable install prompt when nothing is on disk', async () => {
    const provider = new CopilotProvider({
      sdkEntryPath: join(dir, 'absent', 'dist', 'cjs', 'index.js'),
    });

    await expect(provider.initialize()).rejects.toThrow(/Settings → GitHub Copilot/);

    const err = await provider.initialize().catch((e: unknown) => e);
    expect((err as { isActionable?: boolean }).isActionable).toBe(true);
    expect((err as Error).message).toMatch(/choose Install/);
    expect((err as Error).message).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });

  it('reports a damaged install (root on disk, entry unloadable) as needing repair', async () => {
    const installRoot = join(dir, 'package');
    await mkdir(installRoot, { recursive: true });
    const provider = new CopilotProvider({
      sdkEntryPath: join(installRoot, 'dist', 'cjs', 'index.js'),
      sdkInstallRoot: installRoot,
    });

    const err = await provider.initialize().catch((e: unknown) => e);
    expect((err as { isActionable?: boolean }).isActionable).toBe(true);
    expect((err as Error).message).toMatch(/damaged/);
    expect((err as Error).message).toMatch(/choose Repair/);
    expect((err as Error).message).not.toMatch(/choose Install\b/);
    expect((err as Error).message).not.toMatch(/ERR_MODULE_NOT_FOUND/);
  });
});
