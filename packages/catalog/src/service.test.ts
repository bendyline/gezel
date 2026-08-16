import { describe, expect, it } from 'vitest';
import { CatalogService } from './service.js';
import { BundledSource } from './source.js';

/**
 * Smoke test against the bundled catalog data shipped with this package.
 * If you add a new bundled item and these counts change, update the
 * expectations.
 */
describe('CatalogService against bundled data', () => {
  const service = new CatalogService([new BundledSource()]);

  it('lists chat-model recommendations from the bundled catalog', async () => {
    const items = await service.list('chat-model');
    expect(items.length).toBeGreaterThan(0);
    const ids = items.map((i) => i.manifest.id);
    expect(ids).toContain('llama3.2-3b-q4');
    expect(ids).toContain('qwen3.6-27b-q4');
    expect(ids).toContain('ternary-bonsai-27b-q2');
    expect(ids).toContain('gemma4-e4b-q4');
  });

  it('exposes Ternary Bonsai 27B through the MLX engine', async () => {
    const detail = await service.get('chat-model', 'ternary-bonsai-27b-q2');
    expect(detail?.manifest.kind).toBe('chat-model');
    if (detail?.manifest.kind === 'chat-model') {
      // Identity, not version: content ships on its own cadence, and pinning
      // the exact version here made every unrelated content patch a test edit.
      expect(detail.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(detail.manifest.llamaCpp).toBeUndefined();
      expect(detail.manifest.mlx).toMatchObject({
        huggingfaceRepo: 'prism-ml/Ternary-Bonsai-27B-mlx-2bit',
        revision: '70f75f3ad081ab840a42f3304c02c27e7f89bfb7',
        quantization: '2bit',
      });
    }
  });

  it('caps Gemma E4B thinking so llama.cpp does not use the unrestricted default', async () => {
    const detail = await service.get('chat-model', 'gemma4-e4b-q4');
    expect(detail?.manifest.kind).toBe('chat-model');
    if (detail?.manifest.kind === 'chat-model') {
      expect(detail.manifest.tuning?.reasoning?.thinkingBudget).toBe(96);
      expect(detail.manifest.tuning?.profiles?.['thinking-coding']?.sampling?.maxTokens).toBe(
        12288,
      );
      expect(detail.manifest.behaviors).toContain('prompt.meester-build-prelude');
      expect(detail.manifest.behaviors).toContain('mcp.compact-tool-schemas');
    }
  });

  it('compacts tool schemas for every medium-tier Qwen 3.6 variant', async () => {
    const ids = ['qwen3.6-27b-q4', 'qwen3.6-27b-q8', 'qwen3.6-35b-a3b-q4', 'qwen3.6-35b-a3b-q8'];
    for (const id of ids) {
      const detail = await service.get('chat-model', id);
      expect(detail?.manifest.kind, id).toBe('chat-model');
      if (detail?.manifest.kind === 'chat-model') {
        expect(detail.manifest.behaviors, id).toContain('mcp.compact-tool-schemas');
      }
    }
  });

  it('lists gezel templates including the meester', async () => {
    const items = await service.list('gezel-template');
    const ids = items.map((i) => i.manifest.id);
    expect(ids).toContain('meester');
    expect(ids).toContain('voorman');
  });

  it('returns full detail (with about.md) for the meester template', async () => {
    const detail = await service.get('gezel-template', 'meester');
    expect(detail).not.toBeNull();
    expect(detail!.about).toBeDefined();
    expect(detail!.about).toContain('Meester');
  });

  it('returns the latest Developer template with follow-up feature discipline', async () => {
    const detail = await service.get('gezel-template', 'developer');
    expect(detail).not.toBeNull();
    expect(detail!.manifest.kind).toBe('gezel-template');
    expect(detail!.manifest.version).toBe('1.4.0');
    expect(detail!.about).toContain('Treat the latest request as the delta');
    expect(detail!.about).toContain('Finish the whole feature path');
    expect(detail!.about).toContain('Data shape, input, handler, persistence, render');
  });

  it('lists at least one toolset', async () => {
    const items = await service.list('toolset');
    expect(items.length).toBeGreaterThan(0);
  });

  it('returns null for unknown items', async () => {
    expect(await service.get('chat-model', 'definitely-not-a-real-model')).toBeNull();
  });

  it('lists curated image-model recommendations spanning the hardware tiers', async () => {
    const items = await service.list('image-model');
    expect(items.length).toBeGreaterThan(0);
    const ids = items.map((i) => i.manifest.id);
    // Sanity check: each tier from low-end laptop to flagship workstation has at least one entry.
    expect(ids).toContain('sd-1.5');
    expect(ids).toContain('sdxl-base-1.0');
    expect(ids).toContain('flux-1-schnell-q4');
  });

  it('flags non-commercial image models so the UI can warn the user', async () => {
    const items = await service.list('image-model');
    const fluxDev = items.find((i) => i.manifest.id === 'flux-1-dev-q4');
    expect(fluxDev).toBeDefined();
    if (fluxDev?.manifest.kind === 'image-model') {
      expect(fluxDev.manifest.commercialUse).toBe(false);
    }
  });

  it('attaches auxiliary files to diffusion-model entries (FLUX et al.)', async () => {
    const flux = await service.get('image-model', 'flux-1-schnell-q4');
    expect(flux).not.toBeNull();
    if (flux?.manifest.kind === 'image-model') {
      expect(flux.manifest.weightsKind).toBe('diffusion-model');
      const roles = flux.manifest.auxiliaryFiles.map((a) => a.role);
      expect(roles).toEqual(expect.arrayContaining(['vae', 'clip_l', 't5xxl']));
    }
  });

  it('exposes availableVersions on every resolved manifest', async () => {
    for (const kind of ['toolset', 'gezel-template', 'chat-model', 'image-model'] as const) {
      const items = await service.list(kind);
      for (const item of items) {
        expect(item.manifest.availableVersions.length).toBeGreaterThan(0);
        // Resolved version should be the head of availableVersions
        // (newest non-yanked).
        expect(item.manifest.availableVersions[0]).toBe(item.manifest.version);
      }
    }
  });

  it('listVersions returns at least one entry for each bundled item', async () => {
    const meester = await service.listVersions('gezel-template', 'meester');
    expect(meester.length).toBeGreaterThan(0);
    expect(meester[0]?.yanked).toBe(false);
    const github = await service.listVersions('toolset', 'github');
    expect(github.length).toBeGreaterThan(0);
  });
});

describe('CatalogService content root', () => {
  it('reports the provider value, re-read on every call', () => {
    let root = '/tmp/gilde-a';
    const service = new CatalogService(undefined, { contentRoot: () => root });
    expect(service.contentRoot()).toBe('/tmp/gilde-a');
    root = '/tmp/gilde-b';
    expect(service.contentRoot()).toBe('/tmp/gilde-b');
  });

  it('is null without a provider (explicit sources or plain defaults)', () => {
    expect(new CatalogService([new BundledSource()]).contentRoot()).toBeNull();
    expect(new CatalogService().contentRoot()).toBeNull();
  });
});
