import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';
import {
  type LooseRecord,
  applyJsonMergePatch,
  assembleManifest,
  providerBlocksWithoutRevision,
} from './manifest-assembly.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(gildeDataDir(), 'chat-models');
const CONFIG_DIR = join(HERE, '..', 'scripts', 'manifest-configs');

describe('assembleManifest merge semantics', () => {
  const cfg: LooseRecord = {
    id: 'demo',
    name: 'Demo',
    description: 'd',
    tags: ['a'],
    category: 'general',
    maintainer: { name: 'x' },
    version: '1.0.0',
    updatedAt: '2026-01-01T00:00:00Z',
    license: 'MIT',
    parameterSize: '8B',
    approxSizeBytes: 1,
    supportsTools: true,
    contextWindow: 4096,
    upstream: 'https://example.com',
    tuning: { sampling: { temperature: 0.5 } },
    behaviors: ['seed-behavior'],
  };
  const freshLlama = { huggingfaceRepo: 'org/repo-GGUF', shards: [], approxSizeBytes: 10 };

  it('seeds a brand-new manifest entirely from the config', () => {
    const { manifest } = assembleManifest({
      cfg,
      providerBlocks: { llamaCpp: { ...freshLlama } },
      existing: null,
    });
    expect(manifest.name).toBe('Demo');
    expect(manifest.tuning).toEqual({ sampling: { temperature: 0.5 } });
    expect(manifest.llamaCpp).toEqual(freshLlama);
  });

  it('preserves manifest-resident tuning over a stale/absent config value', () => {
    const existing: LooseRecord = {
      ...cfg,
      // The eval-evolved tuning the config never caught up to:
      tuning: { sampling: { temperature: 0.7 }, reasoning: { thinkingBudget: 4096 } },
      behaviors: ['seed-behavior', 'eval-added-behavior'],
    };
    const { manifest, preservedFromManifest } = assembleManifest({
      cfg,
      providerBlocks: { llamaCpp: { ...freshLlama } },
      existing,
    });
    expect(manifest.tuning).toEqual(existing.tuning);
    expect(manifest.behaviors).toEqual(['seed-behavior', 'eval-added-behavior']);
    expect(preservedFromManifest).toContain('tuning');
    expect(preservedFromManifest).toContain('behaviors');
  });

  it('fills a field the manifest lacks from the config (gap-fill, not drop)', () => {
    const { existing } = { existing: { ...cfg, tuning: undefined } as LooseRecord };
    delete existing.tuning;
    const { manifest } = assembleManifest({
      cfg,
      providerBlocks: { llamaCpp: { ...freshLlama } },
      existing,
    });
    expect(manifest.tuning).toEqual({ sampling: { temperature: 0.5 } });
  });

  it('reseed lets the config overwrite manifest editorial', () => {
    const existing: LooseRecord = { ...cfg, tuning: { sampling: { temperature: 0.7 } } };
    const { manifest } = assembleManifest({
      cfg,
      providerBlocks: { llamaCpp: { ...freshLlama } },
      existing,
      reseed: true,
    });
    expect(manifest.tuning).toEqual({ sampling: { temperature: 0.5 } });
  });

  it('carries the revision pin onto a freshly fetched provider block', () => {
    const existing: LooseRecord = {
      ...cfg,
      llamaCpp: { huggingfaceRepo: 'org/repo-GGUF', revision: 'abc123', shards: [] },
    };
    const { manifest, carriedRevisions } = assembleManifest({
      cfg,
      providerBlocks: { llamaCpp: { ...freshLlama } },
      existing,
    });
    const block = manifest.llamaCpp as LooseRecord;
    expect(block.revision).toBe('abc123');
    // Inserted right after huggingfaceRepo for minimal disk diffs.
    expect(Object.keys(block)).toEqual([
      'huggingfaceRepo',
      'revision',
      'shards',
      'approxSizeBytes',
    ]);
    expect(carriedRevisions).toEqual(['llamaCpp']);
  });

  it('does not carry a revision pin across a Hugging Face repo change', () => {
    const existing: LooseRecord = {
      ...cfg,
      llamaCpp: { huggingfaceRepo: 'org/old-GGUF', revision: 'abc123', shards: [] },
    };
    const { manifest, carriedRevisions } = assembleManifest({
      cfg,
      providerBlocks: {
        llamaCpp: { ...freshLlama, huggingfaceRepo: 'org/new-GGUF' },
      },
      existing,
    });
    expect((manifest.llamaCpp as LooseRecord).revision).toBeUndefined();
    expect(carriedRevisions).toEqual([]);
  });
});

describe('applyJsonMergePatch', () => {
  it('merges nested release tuning without replacing evolved siblings', () => {
    const manifest = {
      version: '1.0.0',
      tuning: {
        sampling: { temperature: 0.7 },
        engine: {
          llamaCpp: {
            contextSize: 65536,
            spec: { type: 'draft-simple', draftModelId: 'old-draft' },
          },
        },
      },
    };
    const patched = applyJsonMergePatch(manifest, {
      version: '1.0.1',
      tuning: {
        engine: {
          llamaCpp: {
            spec: {
              type: null,
              draftModelId: null,
              mtp: true,
              nMax: 4,
            },
          },
        },
      },
    });
    expect(patched).toEqual({
      version: '1.0.1',
      tuning: {
        sampling: { temperature: 0.7 },
        engine: {
          llamaCpp: {
            contextSize: 65536,
            spec: { mtp: true, nMax: 4 },
          },
        },
      },
    });
    expect(manifest.tuning.engine.llamaCpp.spec).toEqual({
      type: 'draft-simple',
      draftModelId: 'old-draft',
    });
  });
});

/**
 * The systemic guard: every model already on disk must survive a rebuild
 * with zero loss. We simulate a refresh — feed the manifest's own config
 * plus its provider blocks stripped of their revision pins (exactly what a
 * fresh HF fetch yields) back through `assembleManifest` — and assert the
 * result is byte-for-byte identical to the manifest. If anyone makes the
 * build lossy again (drops tuning, ignores a pin, fails to preserve a
 * field), this fails at commit time instead of silently in a model dir.
 */
describe('rebuild safety (no current manifest loses data on rebuild)', () => {
  function loadConfigsById(): Map<string, LooseRecord> {
    const out = new Map<string, LooseRecord>();
    for (const f of readdirSync(CONFIG_DIR)) {
      if (!f.endsWith('.json')) continue;
      const cfg = JSON.parse(readFileSync(join(CONFIG_DIR, f), 'utf8')) as LooseRecord;
      if (typeof cfg.id === 'string') out.set(cfg.id, cfg);
    }
    return out;
  }

  function findCurrentManifests(): Array<{ id: string; path: string }> {
    const out: Array<{ id: string; path: string }> = [];
    for (const prefix of readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!prefix.isDirectory()) continue;
      for (const entry of readdirSync(join(DATA_DIR, prefix.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = join(DATA_DIR, prefix.name, entry.name, 'manifest.json');
        if (existsSync(p)) out.push({ id: entry.name, path: p });
      }
    }
    return out;
  }

  const configs = loadConfigsById();
  const manifests = findCurrentManifests();

  it('finds the catalog data on disk', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(20);
  });

  for (const { id, path } of manifests) {
    it(`${id}: a config-driven rebuild reproduces the manifest exactly`, () => {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as LooseRecord;
      const cfg = configs.get(String(manifest.id ?? id));
      // Every current model is expected to have a config; flag it loudly if
      // not, since a config-less manifest can't be rebuilt at all.
      expect(cfg, `no manifest-config for ${id}`).toBeTruthy();
      if (!cfg) return;

      const { manifest: rebuilt } = assembleManifest({
        cfg,
        providerBlocks: providerBlocksWithoutRevision(manifest),
        existing: manifest,
        reseed: false,
      });
      expect(rebuilt).toEqual(manifest);
    });
  }
});
