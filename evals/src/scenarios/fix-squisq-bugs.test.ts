import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  FIX_SQUISQ_TRUSTED_CHECK_PATH,
  FIX_SQUISQ_TRUSTED_CHECK_SOURCE,
  GEOHASH_TS,
  HAVERSINE_TS,
  PERSISTENCE_TS,
  detectDeepValidation,
  detectGracefulErrors,
  detectGreatCirclePath,
  fixSquisqBugsScenario,
  fixSquisqFeedbackTarget,
  runBehavioralChecksInDir,
} from './fix-squisq-bugs.ts';
import { spawnAndAwait } from './helpers.ts';
import { TRUSTED_CHECK_RUNNER_ENV } from './trusted-check-runner.ts';

// A realistic FIXED Geohash.ts: great-circle (slerp via 3D vectors / trig)
// path sampling, and graceful empty-returns on bad-length input.
const FIXED_GEOHASH = `import { haversineDistance, toRadians, toDegrees } from './Haversine.ts';
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function decodeGeohashCenter(hash) { return { lat: 0, lng: 0 }; }
export function encodeGeohash(lat, lng, p = 4) { return 'u1hx'; }
export function getGeohashPath(from, to, stepKm = 15) {
  const a = decodeGeohashCenter(from);
  const b = decodeGeohashCenter(to);
  const distance = haversineDistance(a.lat, a.lng, b.lat, b.lng);
  const steps = Math.max(1, Math.round(distance / stepKm));
  const path = [];
  const φ1 = toRadians(a.lat), λ1 = toRadians(a.lng);
  const φ2 = toRadians(b.lat), λ2 = toRadians(b.lng);
  const d = distance / 6371;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const lat = toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lng = toDegrees(Math.atan2(y, x));
    path.push({ lat, lng });
  }
  return path;
}
export function getGeohash4Neighbors(hash) {
  if (hash.length !== 4) {
    return [];
  }
  return ['a', 'b', 'c', 'd'];
}
export function geohashToHierarchicalPath(hash) {
  if (hash.length !== 4) {
    return '';
  }
  return [hash.slice(0, 1), hash.slice(0, 2), hash.slice(0, 3), hash].join('/');
}
`;

// A realistic FIXED persistence.ts: recursive per-layer validation.
const FIXED_PERSISTENCE = `export function assertImageEditDoc(value) {
  if (typeof value !== 'object' || value === null) throw new Error('must be object');
  const doc = value;
  if (typeof doc.version !== 'number') throw new Error('version');
  if (typeof doc.canvas !== 'object' || doc.canvas === null) throw new Error('canvas');
  if (!Array.isArray(doc.layers)) throw new Error('layers');
  for (const layer of doc.layers) {
    if (typeof layer !== 'object' || layer === null) throw new Error('layer must be object');
    if (typeof layer.id !== 'string') throw new Error('layer.id');
    if (layer.type !== 'image' && layer.type !== 'text' && layer.type !== 'shape')
      throw new Error('layer.type');
    if (typeof layer.x !== 'number' || typeof layer.y !== 'number') throw new Error('layer coords');
  }
}
`;

describe('fix-squisq-bugs detectors — buggy seed reads as UNFIXED', () => {
  it('great-circle: the seeded linear getGeohashPath is not detected as fixed', () => {
    expect(detectGreatCirclePath(GEOHASH_TS)).toBe(false);
  });
  it('graceful-errors: the seeded throwing guards are not detected as fixed', () => {
    expect(detectGracefulErrors(GEOHASH_TS)).toBe(false);
  });
  it('deep-validation: the seeded shallow assert is not detected as fixed', () => {
    expect(detectDeepValidation(PERSISTENCE_TS)).toBe(false);
  });
  it('null files read as unfixed', () => {
    expect(detectGreatCirclePath(null)).toBe(false);
    expect(detectGracefulErrors(null)).toBe(false);
    expect(detectDeepValidation(null)).toBe(false);
  });
});

describe('fix-squisq-bugs detectors — realistic fix reads as FIXED', () => {
  it('great-circle: a slerp/trig path sampler is detected', () => {
    expect(detectGreatCirclePath(FIXED_GEOHASH)).toBe(true);
  });
  it('graceful-errors: empty-return guards are detected', () => {
    expect(detectGracefulErrors(FIXED_GEOHASH)).toBe(true);
  });
  it('deep-validation: per-layer loop + field checks are detected', () => {
    expect(detectDeepValidation(FIXED_PERSISTENCE)).toBe(true);
  });
});

describe('fix-squisq-bugs feedback routing', () => {
  it('routes a tsc diagnostic for persistence.ts to persistence.ts, not Geohash.ts', () => {
    const target = fixSquisqFeedbackTarget(
      "tsc-clean failed: packages/core/src/imageEdit/persistence.ts(27,20): error TS2339: Property 'id' does not exist on type 'object'.",
      ['great-circle-path', 'graceful-errors', 'deep-layer-validation', 'haversine-untouched'],
    );
    expect(target).toBe('packages/core/src/imageEdit/persistence.ts');
  });

  it('routes antimeridian and graceful-errors failures to Geohash.ts', () => {
    expect(
      fixSquisqFeedbackTarget(
        'getGeohashPath behavioral check failed: path must cross the antimeridian',
        ['haversine-untouched'],
      ),
    ).toBe('packages/core/src/spatial/Geohash.ts');
    expect(
      fixSquisqFeedbackTarget('graceful-errors behavioral check failed: still throws', [
        'great-circle-path',
        'haversine-untouched',
      ]),
    ).toBe('packages/core/src/spatial/Geohash.ts');
  });
});

describe('fix-squisq-bugs detectors — partial / fake fixes do NOT pass', () => {
  it('great-circle: removing the linear lerp but adding no spherical math is not enough', () => {
    const half = FIXED_GEOHASH.replace(
      /const A = [\s\S]*?path\.push\([^)]*\);/,
      'path.push({lat:0,lng:0});',
    );
    // No atan2/sin/cos sampler and no helper → not a real great-circle fix.
    expect(detectGreatCirclePath(half)).toBe(false);
  });
  it('graceful-errors: fixing only one of the two guards is not enough', () => {
    const onlyArray = `export function getGeohash4Neighbors(h){ if(h.length!==4){return [];} return []; }
export function geohashToHierarchicalPath(h){ if(h.length!==4){ throw new Error('bad'); } return ''; }`;
    expect(detectGracefulErrors(onlyArray)).toBe(false);
  });
  it('deep-validation: looping without checking layer fields is not enough', () => {
    const loopOnly =
      'export function assertImageEditDoc(v){ for (const layer of v.layers) { /* noop */ } }';
    expect(detectDeepValidation(loopOnly)).toBe(false);
  });
});

// The exact shape qwen3.6-27b-q4 emitted in the sweeps: a
// C-style index loop with full per-field checks. The original detector
// rejected this (it only matched for-of/in + functional iteration) and
// false-failed the model 0/5 with correct code on disk. Also doubles as
// the behaviorally-correct persistence fixture below.
const INDEX_LOOP_PERSISTENCE = `export function assertImageEditDoc(value) {
  if (typeof value !== 'object' || value === null) throw new Error('ImageEditDoc must be an object');
  const doc = value;
  if (typeof doc.version !== 'number') throw new Error('ImageEditDoc.version must be a number');
  if (typeof doc.canvas !== 'object' || doc.canvas === null) throw new Error('ImageEditDoc.canvas must be an object');
  if (!Array.isArray(doc.layers)) throw new Error('ImageEditDoc.layers must be an array');
  const validTypes = ['image', 'text', 'shape'];
  for (let i = 0; i < doc.layers.length; i++) {
    const layer = doc.layers[i];
    if (typeof layer !== 'object' || layer === null) throw new Error('layer ' + i + ' must be a non-null object');
    const l = layer;
    if (typeof l.id !== 'string') throw new Error('layer ' + i + ' id must be a string');
    if (typeof l.type !== 'string' || !validTypes.includes(l.type)) throw new Error('layer ' + i + ' type invalid');
    if (typeof l.x !== 'number' || typeof l.y !== 'number') throw new Error('layer ' + i + ' x/y must be numbers');
  }
}
export function readImageEditDoc(json) {
  const parsed = JSON.parse(json);
  assertImageEditDoc(parsed);
  return parsed;
}
`;

describe('fix-squisq-bugs detectors — loop-idiom blindness regressions', () => {
  it('deep-validation: C-style index loop over doc.layers is detected (qwen3.6 false-negative)', () => {
    expect(detectDeepValidation(INDEX_LOOP_PERSISTENCE)).toBe(true);
  });
  it('deep-validation: while loop bounded by layers.length is detected', () => {
    const whileLoop = `export function assertImageEditDoc(doc) {
      let i = 0;
      while (i < doc.layers.length) {
        const layer = doc.layers[i];
        if (typeof layer.id !== 'string') throw new Error('id');
        if (layer.type !== 'image' && layer.type !== 'text' && layer.type !== 'shape') throw new Error('type');
        if (typeof layer.x !== 'number' || typeof layer.y !== 'number') throw new Error('xy');
        i++;
      }
    }`;
    expect(detectDeepValidation(whileLoop)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Behavioral gate — runs the model's actual code via Node type-stripping.

/** The seed Geohash.ts transformed into a genuinely-correct fix: slerp
 * path sampling + graceful empty-returns. Built by surgical replacement
 * on the real seed so encode/decode stay the authentic implementations. */
function buildBehaviorallyFixedGeohash(): string {
  let fixed = GEOHASH_TS.replace(
    "import { haversineDistance } from './Haversine.ts';",
    "import { haversineDistance, toDegrees, toRadians } from './Haversine.ts';",
  );
  fixed = fixed.replace(
    /for \(let i = 0; i <= steps; i\+\+\) \{[\s\S]*?path\.push\(\{ lat, lng \}\);\n {2}\}/,
    `const p1 = toRadians(a.lat), l1 = toRadians(a.lng);
  const p2 = toRadians(b.lat), l2 = toRadians(b.lng);
  const delta = distance / 6371;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    if (delta === 0) { path.push({ lat: a.lat, lng: a.lng }); continue; }
    const A = Math.sin((1 - f) * delta) / Math.sin(delta);
    const B = Math.sin(f * delta) / Math.sin(delta);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    path.push({
      lat: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
      lng: toDegrees(Math.atan2(y, x)),
    });
  }`,
  );
  fixed = fixed.replace(
    /throw new Error\([\s\S]{0,120}?getGeohash4Neighbors expects[\s\S]*?\);/,
    'return [];',
  );
  fixed = fixed.replace(
    /throw new Error\([\s\S]{0,120}?geohashToHierarchicalPath expects[\s\S]*?\);/,
    "return '';",
  );
  return fixed;
}

async function writeFixtureWorkspace(
  dir: string,
  geohashTs: string,
  persistenceTs: string,
): Promise<void> {
  await mkdir(join(dir, 'packages/core/src/spatial'), { recursive: true });
  await mkdir(join(dir, 'packages/core/src/imageEdit'), { recursive: true });
  await writeFile(join(dir, 'packages/core/src/spatial/Haversine.ts'), HAVERSINE_TS);
  await writeFile(join(dir, 'packages/core/src/spatial/Geohash.ts'), geohashTs);
  await writeFile(join(dir, 'packages/core/src/imageEdit/persistence.ts'), persistenceTs);
}

describe('fix-squisq-bugs behavioral gate', () => {
  it('the buggy seed fails all three behavioral checks', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/squisq-behavior-test-`);
    try {
      await writeFixtureWorkspace(tmp, GEOHASH_TS, PERSISTENCE_TS);
      const checks = await runBehavioralChecksInDir(tmp);
      expect(checks).not.toBeNull();
      expect(checks!.greatCircle.ok).toBe(false);
      expect(checks!.greatCircle.why).toMatch(/antimeridian/);
      expect(checks!.gracefulErrors.ok).toBe(false);
      expect(checks!.deepValidation.ok).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 40_000);

  it('a real fix passes all three — including the index-loop persistence the regex once rejected', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/squisq-behavior-test-`);
    try {
      await writeFixtureWorkspace(tmp, buildBehaviorallyFixedGeohash(), INDEX_LOOP_PERSISTENCE);
      const checks = await runBehavioralChecksInDir(tmp);
      expect(checks).not.toBeNull();
      expect(checks!.greatCircle).toEqual({ ok: true });
      expect(checks!.gracefulErrors).toEqual({ ok: true });
      expect(checks!.deepValidation).toEqual({ ok: true });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 40_000);

  it('an unimportable workspace reports import failures, not a harness error', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/squisq-behavior-test-`);
    try {
      await writeFixtureWorkspace(tmp, 'this is not typescript {{{', PERSISTENCE_TS);
      const checks = await runBehavioralChecksInDir(tmp);
      expect(checks).not.toBeNull();
      expect(checks!.greatCircle.ok).toBe(false);
      expect(checks!.greatCircle.why).toMatch(/failed to import/);
      // persistence.ts is untouched seed — still independently checkable.
      expect(checks!.deepValidation.ok).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 40_000);

  it.each(['./Haversine', './Haversine.js'])(
    'accepts the bundler-valid %s import spelling',
    async (specifier) => {
      const tmp = await mkdtemp(`${tmpdir()}/squisq-behavior-test-`);
      try {
        const geohash = buildBehaviorallyFixedGeohash().replace('./Haversine.ts', specifier);
        await writeFixtureWorkspace(tmp, geohash, INDEX_LOOP_PERSISTENCE);
        const checks = await runBehavioralChecksInDir(tmp);
        expect(checks).not.toBeNull();
        expect(checks!.greatCircle).toEqual({ ok: true });
        expect(checks!.gracefulErrors).toEqual({ ok: true });
        expect(checks!.deepValidation).toEqual({ ok: true });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it('resolves an existing model-created extensionless TypeScript module', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/squisq-behavior-test-`);
    try {
      const geohash = `import './types';\n${buildBehaviorallyFixedGeohash()}`;
      await writeFixtureWorkspace(tmp, geohash, INDEX_LOOP_PERSISTENCE);
      await writeFile(join(tmp, 'packages/core/src/spatial/types.ts'), 'export const ok = true;\n');
      const checks = await runBehavioralChecksInDir(tmp);
      expect(checks).not.toBeNull();
      expect(checks!.greatCircle).toEqual({ ok: true });
      expect(checks!.gracefulErrors).toEqual({ ok: true });
      expect(checks!.deepValidation).toEqual({ ok: true });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('fix-squisq-bugs - trusted checker treatment', () => {
  it('the pinned checker fails the seed and passes the reference fixes from its nested path', async () => {
    const tmp = await mkdtemp(`${tmpdir()}/squisq-trusted-check-test-`);
    try {
      await writeFixtureWorkspace(tmp, GEOHASH_TS, PERSISTENCE_TS);
      const checkerPath = join(tmp, FIX_SQUISQ_TRUSTED_CHECK_PATH);
      await mkdir(join(tmp, '.gezel-checks'), { recursive: true });
      await writeFile(checkerPath, FIX_SQUISQ_TRUSTED_CHECK_SOURCE);

      const failing = await spawnAndAwait(process.execPath, ['--no-warnings', checkerPath], {
        cwd: tmp,
        timeoutMs: 30_000,
      });
      expect(failing.exitCode).toBe(1);
      expect(failing.stderr).toContain('trusted behavioral checks');

      await writeFixtureWorkspace(
        tmp,
        buildBehaviorallyFixedGeohash().replace('./Haversine.ts', './Haversine'),
        INDEX_LOOP_PERSISTENCE,
      );
      const passing = await spawnAndAwait(process.execPath, ['--no-warnings', checkerPath], {
        cwd: tmp,
        timeoutMs: 30_000,
      });
      expect(passing.exitCode).toBe(0);
      expect(passing.stdout).toContain('PASS 3/3 trusted behavioral checks');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 70_000);

  it('seeds and pins the behavioral checker at the developer turn boundary', async () => {
    vi.stubEnv(TRUSTED_CHECK_RUNNER_ENV, '1');
    try {
      const client = {
        listProjects: vi.fn().mockResolvedValue({
          projects: [{ id: 'squisq-project', name: 'Squisq Core' }],
        }),
        writeProjectWorkspaceFile: vi.fn().mockResolvedValue({}),
        createGezel: vi.fn().mockResolvedValue({ id: 'dani' }),
        addGezelToProject: vi.fn().mockResolvedValue({}),
        sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
      };
      const ctx = { client, log: vi.fn() } as unknown as EvalContext;

      await fixSquisqBugsScenario.setup?.(ctx);

      expect(client.writeProjectWorkspaceFile).toHaveBeenCalledWith('squisq-project', {
        path: FIX_SQUISQ_TRUSTED_CHECK_PATH,
        content: FIX_SQUISQ_TRUSTED_CHECK_SOURCE,
      });
      expect(client.sendChatMessage).toHaveBeenCalledWith(
        'dani',
        expect.objectContaining({
          projectId: 'squisq-project',
          message: expect.stringContaining('caller-pinned trusted checker'),
          expectedDeliverable: {
            kind: 'file',
            filePath: 'packages/core/src/spatial/Geohash.ts',
            scripts: [
              {
                name: 'checkWorkspaceScript',
                scope: 'standard',
                inputs: {
                  script: FIX_SQUISQ_TRUSTED_CHECK_PATH,
                  expectedSource: FIX_SQUISQ_TRUSTED_CHECK_SOURCE,
                  timeoutMs: 120_000,
                },
              },
            ],
          },
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
