import { MemoryContentContainer } from '@bendyline/squisq/storage';
import {
  buildVersionPath,
  listVersions,
  revertToVersion,
  saveVersion,
} from '@bendyline/squisq/versions';
import { describe, expect, it } from 'vitest';
import { createVersionCompatibleContentContainer } from './version-compatible-container.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('version-compatible content container', () => {
  it('aliases extension-preserving and former parent-folder histories', async () => {
    const companion = new MemoryContentContainer();
    const legacyParent = new MemoryContentContainer();
    const first = new Date('2026-08-01T10:00:00Z');
    const second = new Date('2026-08-02T10:00:00Z');
    await companion.writeFile(buildVersionPath('brief.md', first), bytes('companion old'));
    await legacyParent.writeFile(buildVersionPath('brief.md', second), bytes('parent old'));
    await legacyParent.writeFile(buildVersionPath('other.md', second), bytes('other document'));

    const compatible = createVersionCompatibleContentContainer(companion, 'brief', [
      { container: legacyParent, basenames: ['brief.md', 'brief'] },
    ]);
    const versions = await listVersions(compatible, 'brief');

    expect(versions.map((version) => version.basename)).toEqual(['brief', 'brief']);
    expect(new TextDecoder().decode((await compatible.readFile(versions[0]!.path))!)).toBe(
      'parent old',
    );
    expect(versions.some((version) => version.path.includes('other'))).toBe(false);
  });

  it('writes new snapshots with the canonical extensionless basename', async () => {
    const companion = new MemoryContentContainer();
    const compatible = createVersionCompatibleContentContainer(companion, 'brief');
    const now = new Date('2026-08-03T10:00:00Z');

    const result = await saveVersion(compatible, { basename: 'brief', content: 'new', now });

    expect(result.version?.path).toBe(buildVersionPath('brief', now));
    expect(await companion.exists(buildVersionPath('brief', now))).toBe(true);
  });

  it('reverts through the visible document container, not into the sidecar', async () => {
    const companion = new MemoryContentContainer();
    const visible = new MemoryContentContainer();
    await visible.writeDocument('current', 'brief.md');
    const now = new Date('2026-08-03T10:00:00Z');
    const path = buildVersionPath('brief', now);
    await companion.writeFile(path, bytes('historic'));
    const compatible = createVersionCompatibleContentContainer(companion, 'brief', [], visible);

    const [version] = await listVersions(compatible, 'brief');
    await expect(
      revertToVersion(compatible, version!, { snapshotCurrent: false }),
    ).resolves.toMatchObject({ reverted: true });
    expect(await visible.readDocument()).toBe('historic');
    expect(await companion.exists('brief.md')).toBe(false);
  });
});
