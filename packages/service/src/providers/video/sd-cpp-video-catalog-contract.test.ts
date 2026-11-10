import {
  type MediaBackend,
  type MediaMemoryPool,
  VIDEO_ARCHITECTURES,
  type VideoModelManifest,
  sdCppVideoModelRequirement,
  snapVideoFrames,
  snapVideoSide,
} from '@bendyline/gezel';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { videoCatalogWeightFiles } from '../../models/weight-facts.js';
import { ROLE_FLAGS } from './sd-cpp-video.js';

/**
 * Every sd.cpp video entry in the pinned catalog (or the one
 * `GEZEL_GILDE_DATA_DIR` names) against what the engine and the estimator
 * need: a launch flag for every file, the components its family loads, a
 * default clip on the architecture's grid, and a price from known facts.
 */
async function sdCppEntries(): Promise<VideoModelManifest[]> {
  const catalog = new CatalogService([new BundledSource()]);
  return (await catalog.list('video-model'))
    .map((item) => item.manifest)
    .filter((m): m is VideoModelManifest => m.kind === 'video-model' && m.engine === 'sd-cpp');
}

/** Roles each family's sd-server pipeline reads, beside its one diffusion model and a decoder. */
const FAMILY_ROLES: Readonly<Record<string, readonly string[]>> = {
  wan: ['t5xxl'],
  lingbot: ['llm'],
  ltx2: ['llm', 'embeddings_connectors'],
};

describe('sd.cpp video entries in the catalog', () => {
  it('give every file a role sd-server has a flag for, and the roles their family loads', async () => {
    for (const m of await sdCppEntries()) {
      const roles = m.source.files.map((f) => f?.role);
      for (const role of roles) {
        expect(role && role in ROLE_FLAGS, `${m.id}: ${role ?? 'no role'}`).toBe(true);
      }
      expect(
        roles.filter((r) => r === 'diffusion_model'),
        m.id,
      ).toHaveLength(1);
      expect(roles.includes('vae') || roles.includes('tae'), `${m.id}: a decoder`).toBe(true);
      for (const role of FAMILY_ROLES[m.family] ?? []) {
        expect(roles, `${m.id}: ${role}`).toContain(role);
      }
    }
  });

  it('default to a clip on the architecture grid, inside the entry ranges', async () => {
    for (const m of await sdCppEntries()) {
      expect(m.architecture, m.id).toBeDefined();
      const geo = VIDEO_ARCHITECTURES[m.architecture as keyof typeof VIDEO_ARCHITECTURES];
      const { defaultWidth: w, defaultHeight: h, defaultNumFrames: f } = m;
      expect(
        [w, h, f].every((n) => typeof n === 'number'),
        m.id,
      ).toBe(true);
      expect(snapVideoSide(geo, w as number), `${m.id} width`).toBe(w);
      expect(snapVideoSide(geo, h as number), `${m.id} height`).toBe(h);
      expect(snapVideoFrames(geo, f as number), `${m.id} frames`).toBe(f);
      for (const [value, range] of [
        [w, m.widthRange],
        [h, m.heightRange],
        [f, m.numFramesRange],
      ] as const) {
        if (!range) continue;
        expect(value as number, m.id).toBeGreaterThanOrEqual(range.min);
        expect(value as number, m.id).toBeLessThanOrEqual(range.max);
      }
      if (m.imageToVideoOnly) expect(m.supportsImageToVideo, m.id).toBe(true);
    }
  });

  it('price exactly from the catalog on every pool, with any decoder tile on the grid', async () => {
    const places: Array<[MediaMemoryPool, MediaBackend]> = [
      ['unified', 'metal'],
      ['discrete', 'cuda'],
      ['discrete', 'vulkan'],
      ['cpu', 'cpu'],
    ];
    for (const m of await sdCppEntries()) {
      const tile = m.sdCpp?.vaeTiling?.tileSizePx;
      if (tile !== undefined) expect(tile % 64, `${m.id} tile`).toBe(0);
      for (const [pool, backend] of places) {
        const req = sdCppVideoModelRequirement({
          files: videoCatalogWeightFiles(m),
          model: m,
          pool,
          backend,
        });
        expect(req.exact, `${m.id} on ${backend}`).toBe(true);
        expect(req.bytes, `${m.id} on ${backend}`).toBeGreaterThan(0);
      }
    }
  });
});
