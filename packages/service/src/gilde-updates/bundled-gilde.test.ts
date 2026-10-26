import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { validateGezappSource } from '../project-type/gezapp-source.js';
import { bundledGildeDataDir } from './bundled-gilde.js';
import { GildeUpdateManager } from './manager.js';

/**
 * Reproduces the layout where `@bendyline/gezel-catalog` is installed
 * globally beside the service: the catalog cannot see the service's Gilde,
 * so its own lookup fails. Every path here must still find Gilde through
 * the service.
 */
vi.mock('@bendyline/gezel-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bendyline/gezel-catalog')>();
  const unreachable = (): never => {
    throw new Error("Cannot find module '@bendyline/gilde/package.json'");
  };
  class CatalogThatCannotFindGilde extends actual.CatalogService {
    constructor(...args: ConstructorParameters<typeof actual.CatalogService>) {
      const [sources, opts] = args;
      if (!sources?.length && !opts?.contentRoot) unreachable();
      super(...args);
    }
  }
  return {
    ...actual,
    CatalogService: CatalogThatCannotFindGilde,
    gildeDataDir: unreachable,
    gildePackageRoot: unreachable,
  };
});

let home: string;
const previousOverride = process.env.GEZEL_GILDE_DATA_DIR;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-bundled-gilde-'));
  delete process.env.GEZEL_GILDE_DATA_DIR;
});

afterEach(async () => {
  if (previousOverride === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
  else process.env.GEZEL_GILDE_DATA_DIR = previousOverride;
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the service finds its own Gilde', () => {
  it('resolves the content tree from the service package', () => {
    expect(existsSync(join(bundledGildeDataDir(), 'chat-models'))).toBe(true);
  });

  it('honors GEZEL_GILDE_DATA_DIR', () => {
    process.env.GEZEL_GILDE_DATA_DIR = '/override/gilde/data';
    expect(bundledGildeDataDir()).toBe('/override/gilde/data');
  });

  it('boots the update manager with the bundled content and version', async () => {
    const history = new HistoryManager(home);
    const manager = await GildeUpdateManager.create({
      home,
      store: new Store({ home, history }),
      history,
    });
    try {
      expect(manager.contentDataDir()).toBe(bundledGildeDataDir());
      expect((await manager.status()).bundledVersion).not.toBe('unknown');
    } finally {
      manager.stop();
    }
  });

  it('validates an AI App source without the catalog finding Gilde', async () => {
    const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
    const typeDir = 'items/project-types/de/demo-notes';
    const files: Record<string, string> = {
      'gezapp.json': json({
        format: 'gezel-ai-app-source',
        schemaVersion: 1,
        publisher: { name: 'Test Publisher' },
      }),
      [`${typeDir}/manifest.json`]: json({
        schemaVersion: 1,
        kind: 'project-type',
        id: 'demo-notes',
        name: 'Demo Notes',
        description: 'A demo notes workspace.',
        maintainer: { name: 'Test Publisher' },
      }),
      [`${typeDir}/versions/1.0.0/manifest.json`]: json({
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-01-01T00:00:00Z',
      }),
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(home, rel)), { recursive: true });
      await writeFile(join(home, rel), content);
    }
    const result = await validateGezappSource(home);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
