/**
 * Face-lane pure math: YuNet grid decode + NMS against canned tensors, and
 * the Umeyama alignment against known similarity transforms. The real-model
 * plumbing test self-skips unless GEZEL_FACE_MODELS_TEST_DIR points at a
 * directory holding the two pinned ONNX files (they are a ~261 MB download —
 * never fetched by the test suite itself).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCFACE_SIZE, ARCFACE_TEMPLATE, alignToArcFace, umeyama } from './align.js';
import { FACE_MODEL_CATALOG } from './catalog.js';
import { YUNET_INPUT, type YunetOutputs, decodeYunetGrid, nonMaxSuppress } from './yunet.js';

function emptyOutputs(): YunetOutputs {
  const out: YunetOutputs = {};
  for (const s of [8, 16, 32]) {
    const n = (YUNET_INPUT / s) ** 2;
    out[`cls_${s}`] = new Float32Array(n);
    out[`obj_${s}`] = new Float32Array(n);
    out[`bbox_${s}`] = new Float32Array(n * 4);
    out[`kps_${s}`] = new Float32Array(n * 10);
  }
  return out;
}

describe('yunet decode', () => {
  it('decodes one confident cell into a correctly placed box + landmarks', () => {
    const outputs = emptyOutputs();
    const stride = 16;
    const cols = YUNET_INPUT / stride; // 40
    const row = 10;
    const col = 20;
    const i = row * cols + col;
    outputs[`cls_${stride}`]![i] = 0.81;
    outputs[`obj_${stride}`]![i] = 1.0;
    // Center offset (0.5, 0.5); log-space size ln(2) → 2·stride each way.
    outputs[`bbox_${stride}`]!.set([0.5, 0.5, Math.log(2), Math.log(2)], i * 4);
    // First landmark at the cell center, rest offset by +1 cell.
    const kps = [0.5, 0.5, 1.5, 0.5, 1.5, 1.5, 0.5, 1.5, 1, 1];
    outputs[`kps_${stride}`]!.set(kps, i * 10);

    const faces = decodeYunetGrid(outputs, 0.6);
    expect(faces).toHaveLength(1);
    const f = faces[0]!;
    expect(f.score).toBeCloseTo(Math.sqrt(0.81), 5);
    const cx = (col + 0.5) * stride;
    const cy = (row + 0.5) * stride;
    expect(f.x).toBeCloseTo(cx - stride); // w = 2·stride → half-width = stride
    expect(f.y).toBeCloseTo(cy - stride);
    expect(f.w).toBeCloseTo(2 * stride);
    expect(f.h).toBeCloseTo(2 * stride);
    expect(f.landmarks[0]).toBeCloseTo(cx);
    expect(f.landmarks[1]).toBeCloseTo(cy);
    expect(f.landmarks[2]).toBeCloseTo(cx + stride);
  });

  it('sub-threshold cells decode to nothing', () => {
    const outputs = emptyOutputs();
    outputs.cls_8![0] = 0.3;
    outputs.obj_8![0] = 0.3;
    expect(decodeYunetGrid(outputs, 0.6)).toHaveLength(0);
  });

  it('NMS keeps the highest-scoring of overlapping boxes and distinct boxes', () => {
    const base = { landmarks: [] as number[] };
    const kept = nonMaxSuppress(
      [
        { ...base, x: 0, y: 0, w: 100, h: 100, score: 0.8 },
        { ...base, x: 5, y: 5, w: 100, h: 100, score: 0.9 }, // heavy overlap, higher score
        { ...base, x: 300, y: 300, w: 80, h: 80, score: 0.7 }, // disjoint
      ],
      0.3,
    );
    expect(kept.map((f) => f.score)).toEqual([0.9, 0.7]);
  });
});

describe('umeyama alignment', () => {
  it('recovers a known rotation + scale + translation', () => {
    const theta = Math.PI / 6;
    const s = 1.5;
    const tx = 12;
    const ty = -7;
    // src = inverse-transformed template; solving src→template must recover m.
    const src = ARCFACE_TEMPLATE.map(([x, y]) => {
      // template = s·R·src + t  ⇒  src = R⁻¹·((template − t)/s)
      const px = (x - tx) / s;
      const py = (y - ty) / s;
      return [
        px * Math.cos(-theta) - py * Math.sin(-theta),
        px * Math.sin(-theta) + py * Math.cos(-theta),
      ] as [number, number];
    });
    const { m } = umeyama(src, ARCFACE_TEMPLATE);
    for (let i = 0; i < src.length; i++) {
      const [x, y] = src[i]!;
      const mappedX = m[0] * x + m[1] * y + m[2];
      const mappedY = m[3] * x + m[4] * y + m[5];
      expect(mappedX).toBeCloseTo(ARCFACE_TEMPLATE[i]![0], 4);
      expect(mappedY).toBeCloseTo(ARCFACE_TEMPLATE[i]![1], 4);
    }
    // Recovered scale: |[a, c]| = s.
    expect(Math.hypot(m[0], m[3])).toBeCloseTo(s, 4);
  });

  it('identity landmarks warp to (approximately) the source crop', () => {
    // A 112×112 gradient whose landmarks already sit at the template — the
    // warp should be near-identity.
    const data = new Uint8Array(ARCFACE_SIZE * ARCFACE_SIZE * 3);
    for (let y = 0; y < ARCFACE_SIZE; y++) {
      for (let x = 0; x < ARCFACE_SIZE; x++) {
        const i = (y * ARCFACE_SIZE + x) * 3;
        data[i] = x * 2;
        data[i + 1] = y * 2;
        data[i + 2] = 128;
      }
    }
    const landmarks = ARCFACE_TEMPLATE.flat();
    const out = alignToArcFace({ data, width: ARCFACE_SIZE, height: ARCFACE_SIZE }, landmarks);
    const mid = ((56 * ARCFACE_SIZE + 56) * 3) as number;
    expect(Math.abs(out.data[mid]! - data[mid]!)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.data[mid + 1]! - data[mid + 1]!)).toBeLessThanOrEqual(2);
  });
});

describe('face stack (real models, env-gated)', () => {
  const modelsDir = process.env.GEZEL_FACE_MODELS_TEST_DIR;
  const detect = FACE_MODEL_CATALOG.find((m) => m.role === 'detect')!;
  const embed = FACE_MODEL_CATALOG.find((m) => m.role === 'embed')!;
  const detector = modelsDir ? join(modelsDir, 'yunet.onnx') : '';
  const embedder = modelsDir ? join(modelsDir, 'auraface-glintr100.onnx') : '';
  const available = Boolean(modelsDir) && existsSync(detector) && existsSync(embedder);

  it.skipIf(!available)(
    'runs the full detect pipeline on a synthetic image (zero faces, no crash)',
    { timeout: 120_000 },
    async () => {
      const { runFaceDetect } = await import('../../memory/face-embed-core.js');
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { createRequire } = await import('node:module');
      type UpngModule = typeof import('@pdf-lib/upng');
      const req = createRequire(import.meta.url);
      const mod = req('@pdf-lib/upng') as { default?: UpngModule } & UpngModule;
      const UPNG = mod.default ?? mod;

      const dir = await mkdtemp(join(tmpdir(), 'gezel-face-'));
      try {
        const rgba = new Uint8Array(64 * 64 * 4).fill(200);
        const png = Buffer.from(UPNG.encode([rgba.buffer as ArrayBuffer], 64, 64, 0));
        const path = join(dir, 'blank.png');
        await writeFile(path, png);
        const [outcome] = await runFaceDetect([{ path, hash: 'blank' }], { detector, embedder });
        expect(outcome).toMatchObject({ hash: 'blank', faces: [] });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('catalog pins carry a permissive license and a revision-pinned URL', () => {
    expect(detect.license).toBe('MIT');
    expect(embed.license).toBe('Apache-2.0');
    for (const spec of FACE_MODEL_CATALOG) {
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Pinned to an immutable revision, never a branch name.
      expect(spec.url).not.toMatch(/\/(main|master)\//);
    }
  });
});
