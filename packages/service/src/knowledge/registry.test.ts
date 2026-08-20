import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeRegistryFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeRegistry } from './registry.js';

let home: string;
let registry: KnowledgeRegistry;

const REF = {
  publisherId: 'qualla',
  catalogId: 'world-history',
  version: '1.0.0',
  contentDigest: 'a'.repeat(64),
  storageScope: 'user' as const,
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-knowledge-registry-'));
  registry = new KnowledgeRegistry(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('KnowledgeRegistry', () => {
  it('starts empty and round-trips an upsert', () => {
    expect(registry.read().catalogs).toEqual([]);
    registry.upsert(REF);
    const entry = registry.find('qualla', 'world-history');
    expect(entry?.enabled).toBe(true);
    expect(entry?.ref.version).toBe('1.0.0');
  });

  it('upsert replaces the ref for the same identity and clears quarantine', () => {
    registry.upsert(REF);
    registry.quarantine('qualla', 'world-history', 'sha mismatch');
    expect(registry.find('qualla', 'world-history')?.disabledReason).toBe('sha mismatch');
    registry.upsert({ ...REF, version: '1.1.0', contentDigest: 'b'.repeat(64) });
    const entry = registry.find('qualla', 'world-history');
    expect(entry?.ref.version).toBe('1.1.0');
    expect(entry?.disabledReason).toBeUndefined();
    expect(registry.read().catalogs.length).toBe(1);
  });

  it('rejects the same catalog id from a different publisher', () => {
    registry.upsert(REF);
    expect(() => registry.upsert({ ...REF, publisherId: 'impostor' })).toThrow(
      /already installed from publisher 'qualla'/,
    );
  });

  it('enable/disable/quarantine/remove behave and persist', () => {
    registry.upsert(REF);
    expect(registry.setEnabled('qualla', 'world-history', false)).toBe(true);
    expect(registry.find('qualla', 'world-history')?.enabled).toBe(false);
    expect(registry.setEnabled('qualla', 'world-history', true)).toBe(true);
    expect(registry.quarantine('qualla', 'world-history', 'quick_check failed')).toBe(true);
    const entry = registry.find('qualla', 'world-history');
    expect(entry?.enabled).toBe(false);
    expect(entry?.disabledReason).toBe('quick_check failed');
    expect(registry.remove('qualla', 'world-history')?.ref.catalogId).toBe('world-history');
    expect(registry.find('qualla', 'world-history')).toBeNull();
    expect(registry.setEnabled('qualla', 'world-history', true)).toBe(false);
  });

  it('survives a corrupt registry file by quarantining the bytes', async () => {
    registry.upsert(REF);
    await writeFile(knowledgeRegistryFile(home), '{not json', 'utf8');
    expect(registry.read().catalogs).toEqual([]);
    registry.upsert(REF);
    expect(registry.find('qualla', 'world-history')).not.toBeNull();
    const persisted = JSON.parse(await readFile(knowledgeRegistryFile(home), 'utf8'));
    expect(persisted.catalogs.length).toBe(1);
  });
});
