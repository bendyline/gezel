import { writeFile as fsWriteFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { materializeProjectWorkspace, spawnAndAwait } from './helpers.ts';
import { TRUSTED_RUNNER_KICKOFF, trustedCheckRunnerEnabled } from './trusted-check-runner.ts';

/**
 * Fix-squisq-bugs — find-and-fix three documented bugs in an EXISTING
 * codebase. The control scenario for the "can a small model flexibly
 * plan and execute against a real codebase?" experiment (gemma4-e4b vs
 * the existing 20-tool Node-shaped surface).
 *
 * Distinct from `schema-migration` (a coordinated rename the compiler
 * catches): here all three fixes are behavioral, NOT compile-detectable —
 * a buggy `throw` and a correct `return []` both type-check. The primary
 * gate is therefore BEHAVIORAL: the harness imports the model's modules
 * (Node type-strips the .ts directly) and asserts antimeridian handling,
 * graceful empty-returns, and deep-validation rejection. Per-bug
 * STRUCTURAL sniffs remain as the fallback when the behavioral harness
 * can't run, and `tsc-clean` is the secondary guard that the model
 * didn't break the subset while editing. Behavioral-first exists because
 * structural sniffs are style-sensitive — the original deep-validation
 * regex rejected index-based loops and false-failed an entire model
 * (qwen3.6-27b-q4, 0/5) writing correct code.
 *
 * The three bugs are squisq's real Quality-Audit trio (see the seeded
 * `bug_report.md`):
 *   1. `getGeohashPath` linear-interpolates lat/lng — wrong across the
 *      antimeridian + inaccurate over long distances (needs great-circle).
 *   2. `assertImageEditDoc` validates only top-level fields, not each
 *      layer (needs recursive per-layer validation).
 *   3. `getGeohash4Neighbors` / `geohashToHierarchicalPath` THROW on a
 *      bad-length input instead of returning a predictable `[]` / `''`.
 *
 * Fixtures are self-contained (Geohash.ts imports only Haversine.ts;
 * persistence.ts is standalone) so the seeded subset compiles in
 * isolation and a future behavioral harness can import it without
 * squisq's full dependency tree.
 */

const PROJECT_NAME = 'Squisq Core';
const DEVELOPER_NAME = 'Dani';

const requireFromHere = createRequire(import.meta.url);
function resolveTscBin(): string {
  const tscPkg = requireFromHere.resolve('typescript/package.json');
  return join(dirname(tscPkg), 'bin', 'tsc');
}

// ─────────────────────────────────────────────────────────────────────
// Fixture files (the buggy starting state). Faithful to squisq's real
// modules but trimmed to a self-contained, compilable subset.

const PKG_JSON = `{
  "name": "squisq-core",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit" }
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["packages/**/*.ts"]
}
`;

export const HAVERSINE_TS = `// Great-circle distance helper. This file is CORRECT — do not change it;
// it's the tool the geohash path fix should lean on.

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Great-circle distance between two lat/lng points, in kilometers. */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
`;

export const GEOHASH_TS = `import { haversineDistance } from './Haversine.ts';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface LatLng {
  lat: number;
  lng: number;
}

/** Decode a geohash to its cell-center { lat, lng }. */
export function decodeGeohashCenter(hash: string): LatLng {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let isLng = true;
  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    for (let bit = 4; bit >= 0; bit--) {
      const b = (idx >> bit) & 1;
      if (isLng) {
        const mid = (lngLo + lngHi) / 2;
        if (b) lngLo = mid;
        else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (b) latLo = mid;
        else latHi = mid;
      }
      isLng = !isLng;
    }
  }
  return { lat: (latLo + latHi) / 2, lng: (lngLo + lngHi) / 2 };
}

/** Encode a lat/lng to a geohash of the given precision. */
export function encodeGeohash(lat: number, lng: number, precision = 4): string {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let isLng = true;
  let hash = '';
  let ch = 0;
  let bits = 0;
  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngLo = mid;
      } else {
        ch = ch << 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch = ch << 1;
        latHi = mid;
      }
    }
    isLng = !isLng;
    bits += 1;
    if (bits === 5) {
      hash += BASE32[ch];
      bits = 0;
      ch = 0;
    }
  }
  return hash;
}

/**
 * Sample points along the path between two geohash cells.
 *
 * BUG #1 (great-circle accuracy): this linearly interpolates lat/lng
 * between the two centers. That is wrong near the antimeridian (a path
 * from lng 170 to lng -170 should cross +/-180, not run back through 0)
 * and underestimates distance over long spans, so \`steps\` is too low and
 * intermediate cells get skipped.
 */
export function getGeohashPath(from: string, to: string, stepKm = 15): LatLng[] {
  const a = decodeGeohashCenter(from);
  const b = decodeGeohashCenter(to);
  const distance = haversineDistance(a.lat, a.lng, b.lat, b.lng);
  const steps = Math.max(1, Math.round(distance / stepKm));
  const path: LatLng[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = a.lat + t * (b.lat - a.lat);
    const lng = a.lng + t * (b.lng - a.lng);
    path.push({ lat, lng });
  }
  return path;
}

/**
 * The four cardinal-neighbor geohashes of a 4-char cell.
 *
 * BUG #3 (non-graceful failure): throws on a bad-length input. A utility
 * like this should return a predictable empty value so callers don't have
 * to wrap every call in try/catch.
 */
export function getGeohash4Neighbors(hash: string): string[] {
  if (hash.length !== 4) {
    throw new Error(\`getGeohash4Neighbors expects a 4-char geohash, got "\${hash}"\`);
  }
  const c = decodeGeohashCenter(hash);
  const dLat = 0.04;
  const dLng = 0.04;
  return [
    encodeGeohash(c.lat + dLat, c.lng),
    encodeGeohash(c.lat - dLat, c.lng),
    encodeGeohash(c.lat, c.lng + dLng),
    encodeGeohash(c.lat, c.lng - dLng),
  ];
}

/**
 * Break a 4-char geohash into its hierarchical prefixes ("u/u1/u1h/u1hx").
 *
 * BUG #3 (non-graceful failure): same throw-on-bad-input problem as
 * getGeohash4Neighbors. Should return '' for invalid input.
 */
export function geohashToHierarchicalPath(hash: string): string {
  if (hash.length !== 4) {
    throw new Error(\`geohashToHierarchicalPath expects a 4-char geohash, got "\${hash}"\`);
  }
  return [hash.slice(0, 1), hash.slice(0, 2), hash.slice(0, 3), hash.slice(0, 4)].join('/');
}
`;

export const PERSISTENCE_TS = `// Sidecar persistence for the layered image editor.

export type LayerType = 'image' | 'text' | 'shape';

export interface Layer {
  id: string;
  type: LayerType;
  x: number;
  y: number;
  [extra: string]: unknown;
}

export interface ImageEditDoc {
  version: number;
  canvas: { width: number; height: number };
  layers: Layer[];
}

/**
 * Validate that an unknown value is a well-formed ImageEditDoc.
 *
 * BUG #2 (shallow validation): this checks only the top-level fields. It
 * does NOT validate the contents of \`layers\` — a parsable doc whose
 * layers are missing \`id\`/\`type\`/coords passes here and crashes later
 * deep in the render path. The fix is recursive per-layer validation:
 * every entry in \`layers\` must be a non-null object with a string \`id\`,
 * a \`type\` of 'image' | 'text' | 'shape', and numeric \`x\` / \`y\`.
 */
export function assertImageEditDoc(value: unknown): asserts value is ImageEditDoc {
  if (typeof value !== 'object' || value === null) {
    throw new Error('ImageEditDoc must be an object');
  }
  const doc = value as Record<string, unknown>;
  if (typeof doc.version !== 'number') {
    throw new Error('ImageEditDoc.version must be a number');
  }
  if (typeof doc.canvas !== 'object' || doc.canvas === null) {
    throw new Error('ImageEditDoc.canvas must be an object');
  }
  if (!Array.isArray(doc.layers)) {
    throw new Error('ImageEditDoc.layers must be an array');
  }
}

/** Parse + validate a serialized ImageEditDoc. */
export function readImageEditDoc(json: string): ImageEditDoc {
  const parsed: unknown = JSON.parse(json);
  assertImageEditDoc(parsed);
  return parsed;
}
`;

const BUG_REPORT_MD = `# Quality Audit Report - squisq core

Three high-impact bugs to fix in this seeded subset. Read the named files,
then fix each one in place. Do not change Haversine.ts (it is correct).

## 1. Insufficient geodesic accuracy (packages/core/src/spatial/Geohash.ts)

\`getGeohashPath\` linearly interpolates lat/lng between the two geohash
centers (\`t = i / steps\`). That is not a great-circle route: it is wrong
across the antimeridian (170 -> -170 should cross +/-180, not run back
through 0) and underestimates long distances. **Fix:** sample along the
great-circle / shortest arc between the two points (spherical
interpolation) and size the steps from the true distance.

## 2. Shallow ImageEditDoc validation (packages/core/src/imageEdit/persistence.ts)

\`assertImageEditDoc\` checks only top-level fields; a doc with malformed
\`layers\` passes and crashes later. **Fix:** recursively validate every
entry in \`layers\` — each must be a non-null object with a string \`id\`, a
\`type\` of 'image' | 'text' | 'shape', and numeric \`x\` / \`y\`.

## 3. Non-graceful error handling (packages/core/src/spatial/Geohash.ts)

\`getGeohash4Neighbors\` and \`geohashToHierarchicalPath\` \`throw\` when the
input is not 4 characters. **Fix:** return a predictable empty value
(\`[]\` and \`''\` respectively) on invalid-length input instead of throwing.
`;

// ─────────────────────────────────────────────────────────────────────

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

const GEOHASH_PATH = 'packages/core/src/spatial/Geohash.ts';
const HAVERSINE_PATH = 'packages/core/src/spatial/Haversine.ts';
const PERSISTENCE_PATH = 'packages/core/src/imageEdit/persistence.ts';
export const FIX_SQUISQ_TRUSTED_CHECK_PATH = '.gezel-checks/fix-squisq-bugs.mjs';

async function setup({ client, log }: EvalContext): Promise<void> {
  const trustedRunner = trustedCheckRunnerEnabled();
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A self-contained subset of the squisq core package with three documented bugs to fix ' +
        '(see bug_report.md): a non-great-circle geohash path, shallow ImageEditDoc validation, ' +
        'and throw-on-bad-input utility functions. Read the named files, then fix each bug in place.',
      missionObjectives: [
        '1. Read bug_report.md and every file under packages/core/src/ before editing.',
        `2. Fix ${GEOHASH_PATH}: getGeohashPath must sample the great-circle path, not linear lat/lng.`,
        `3. Fix ${PERSISTENCE_PATH}: assertImageEditDoc must recursively validate every layer.`,
        `4. Fix ${GEOHASH_PATH}: getGeohash4Neighbors returns [] and geohashToHierarchicalPath returns '' on bad-length input (no throw).`,
        '5. Do NOT modify Haversine.ts — it is correct and getGeohashPath should use it.',
        '6. The code must still compile (tsc --noEmit).',
      ].join(' '),
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('fix-squisq-bugs setup: failed to resolve project id');

  const seedFiles: Array<{ path: string; content: string }> = [
    { path: 'package.json', content: PKG_JSON },
    { path: 'tsconfig.json', content: TSCONFIG_JSON },
    { path: 'bug_report.md', content: BUG_REPORT_MD },
    { path: HAVERSINE_PATH, content: HAVERSINE_TS },
    { path: GEOHASH_PATH, content: GEOHASH_TS },
    { path: PERSISTENCE_PATH, content: PERSISTENCE_TS },
    ...(trustedRunner
      ? [{ path: FIX_SQUISQ_TRUSTED_CHECK_PATH, content: FIX_SQUISQ_TRUSTED_CHECK_SOURCE }]
      : []),
  ];
  for (const f of seedFiles) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${seedFiles.length} fixture files under project ${projectId}`);

  // Pre-recruit the Developer joined to this project (mirrors
  // schema-migration / self-correction): the test is whether a small
  // model can plan + execute the fixes, not whether it can navigate the
  // Meester -> recruit -> join -> assign delegation hops.
  let dev: { id: string };
  try {
    // No hand-written about: the service resolves the shipped Developer
    // template (product-shaped prompt). Task specifics live in the
    // kickoff message below — the eval measures the product
    // configuration, not a scenario-tuned system prompt.
    const created = await client.createGezel({
      name: DEVELOPER_NAME,
      role: 'Developer',
    });
    dev = { id: created.id };
    log(`[scenario:setup] created developer "${DEVELOPER_NAME}" id=${dev.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === DEVELOPER_NAME);
    if (!existing) throw err;
    dev = { id: existing.id };
    log(`[scenario:setup] reusing developer "${DEVELOPER_NAME}" id=${dev.id}`);
  }
  await client.addGezelToProject(projectId, dev.id);
  log(`[scenario:setup] joined ${DEVELOPER_NAME} to project ${projectId}`);

  await client.sendChatMessage(dev.id, {
    message: [
      'Please fix the three bugs in bug_report.md. Start by reading bug_report.md and the source',
      'files under packages/core/src/ (Geohash.ts, Haversine.ts, imageEdit/persistence.ts) —',
      'paths are relative to the workspace root, no leading "workspace/". Then',
      'edit the buggy files in place: great-circle path sampling in getGeohashPath, recursive',
      'per-layer validation in assertImageEditDoc, and graceful empty-return (no throw) on',
      'bad-length input in getGeohash4Neighbors / geohashToHierarchicalPath. Do NOT touch',
      'Haversine.ts. Do NOT run npm install or any shell command — there is no node_modules;',
      'the project is compiled with `tsc --noEmit` automatically every few seconds and',
      'failures are reported back to you via chat.',
      ...(trustedRunner ? [TRUSTED_RUNNER_KICKOFF] : []),
    ].join(' '),
    projectId,
    ...(trustedRunner
      ? {
          expectedDeliverable: {
            kind: 'file' as const,
            filePath: GEOHASH_PATH,
            scripts: [
              {
                name: 'checkWorkspaceScript',
                scope: 'standard' as const,
                inputs: {
                  script: FIX_SQUISQ_TRUSTED_CHECK_PATH,
                  expectedSource: FIX_SQUISQ_TRUSTED_CHECK_SOURCE,
                  timeoutMs: 120_000,
                },
              },
            ],
          },
        }
      : {}),
  });
  log(`[scenario:setup] sent kickoff to ${DEVELOPER_NAME} in project ${projectId}`);
}

const tscRunCache = new WeakMap<EvalContext, { lastHash: string; lastResult: boolean }>();

const FIX_SIGNAL_NAMES = [
  'great-circle-path',
  'graceful-errors',
  'deep-layer-validation',
  'haversine-untouched',
  'tsc-clean',
] as const;

/** Strip TS/JS comments so prose like "// linear interpolation" doesn't trip a sniff. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Tiny FNV-1a content hash for cache keys — collision-resistant enough
 * to distinguish same-length rewrites (the length-only tsc hash can't). */
function simpleHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function fixSquisqFeedbackTarget(
  failReason: string | undefined,
  signals: readonly string[],
): string {
  const reason = failReason ?? '';
  if (reason.includes(PERSISTENCE_PATH) || /assertImageEditDoc|deep-layer/i.test(reason)) {
    return PERSISTENCE_PATH;
  }
  if (reason.includes(HAVERSINE_PATH) || /Haversine\.ts was modified/i.test(reason)) {
    return HAVERSINE_PATH;
  }
  if (
    reason.includes(GEOHASH_PATH) ||
    /getGeohashPath|geohash|great-circle|graceful/i.test(reason)
  ) {
    return GEOHASH_PATH;
  }
  if (
    !signals.includes('deep-layer-validation') &&
    signals.includes('great-circle-path') &&
    signals.includes('graceful-errors')
  ) {
    return PERSISTENCE_PATH;
  }
  return GEOHASH_PATH;
}

/** Bug #1 fixed: getGeohashPath no longer linear-interpolates AND uses spherical math. */
export function detectGreatCirclePath(geohashTs: string | null): boolean {
  if (geohashTs === null) return false;
  const code = stripComments(geohashTs);
  // The naive linear form: `<x> + t * (<y> - <x>)` for the lat/lng lerp.
  const stillLinear = /\+\s*t\s*\*\s*\(/.test(code);
  if (stillLinear) return false;
  // Spherical interpolation leaves a recognizable trig fingerprint
  // (atan2 + sin + cos), or delegates to a named great-circle/slerp helper,
  // or re-uses haversine-derived bearing/distance for the steps.
  const hasTrig =
    /Math\.atan2\s*\(/.test(code) && /Math\.sin\s*\(/.test(code) && /Math\.cos\s*\(/.test(code);
  const hasHelper =
    /\b(slerp|greatCircle|intermediatePoint|interpolateGreatCircle|bearing)\b/i.test(code);
  return hasTrig || hasHelper;
}

/** Bug #3 fixed: bad-length guards return [] / '' instead of throwing. */
export function detectGracefulErrors(geohashTs: string | null): boolean {
  if (geohashTs === null) return false;
  const code = stripComments(geohashTs);
  // Each length guard should now return rather than throw. Heuristic:
  // a `length !== 4` (or `!= 4`) check followed (within a few lines) by a
  // `return` and NOT a `throw`. Require both empty-return shapes present.
  const returnsEmptyArray = /length\s*!==?\s*4[\s\S]{0,80}?return\s*\[\s*\]/.test(code);
  const returnsEmptyString = /length\s*!==?\s*4[\s\S]{0,80}?return\s*(['"`])\1/.test(code);
  // And no `throw` immediately after a length check anymore.
  const stillThrows = /length\s*!==?\s*4[\s\S]{0,80}?throw\b/.test(code);
  return returnsEmptyArray && returnsEmptyString && !stillThrows;
}

/**
 * Bug #2 fixed: assertImageEditDoc iterates layers and checks per-layer
 * fields.
 *
 * Style-blindness matters here: this detector MUST accept every loop
 * idiom a model might emit, not just `for...of`. The original version
 * only matched `for (of|in)` + functional iteration and silently
 * rejected C-style index loops (`for (let i = 0; i < doc.layers.length;
 * i++)`) — qwen3.6-27b-q4 idiomatically writes index loops and went 0/5
 * on this scenario in sweeps with CORRECT code on disk every
 * time. The behavioral check (below) is the authoritative gate now; this
 * structural sniff survives as the fallback + feedback path and must
 * stay idiom-agnostic.
 */
export function detectDeepValidation(persistenceTs: string | null): boolean {
  if (persistenceTs === null) return false;
  const code = stripComments(persistenceTs);
  // A loop over layers...
  const iteratesLayers =
    /for\s*\([^)]*\b(of|in)\b[^)]*layers/i.test(code) ||
    /\.layers\b[\s\S]{0,40}?\.(forEach|map|every|some|reduce|filter|find)\s*\(/.test(code) ||
    /\blayers\b[\s\S]{0,40}?\.(forEach|map|every|some|reduce|filter|find)\s*\(/.test(code) ||
    // C-style / while loops bounded by layers.length, with any receiver
    // (`doc.layers.length`, bare `layers.length`).
    /for\s*\([^)]*layers\s*\.\s*length/i.test(code) ||
    /while\s*\([^)]*layers\s*\.\s*length/i.test(code) ||
    // Indexed element access inside the function body (`layers[i]`) —
    // the loop shape that produced the false negatives.
    /\blayers\s*\[\s*\w+\s*\]/.test(code);
  // ...that checks per-layer fields (id / type / the layer-type literals).
  const checksLayerFields =
    /\b(id|type)\b/.test(code) && /(image|text|shape)/.test(code) && /\b(x|y)\b/.test(code);
  return iteratesLayers && checksLayerFields;
}

/** Haversine.ts must be byte-identical to the seed (model was told not to touch it). */
function detectHaversineUntouched(haversineTs: string | null): boolean {
  return haversineTs !== null && haversineTs.trim() === HAVERSINE_TS.trim();
}

async function materializeWorkspace(
  client: GezelClient,
  projectId: string,
  tmp: string,
): Promise<void> {
  await materializeProjectWorkspace(client, projectId, tmp, { include: /\.(ts|tsx|json)$/ });
}

async function runTsc(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<{ ok: boolean; firstError?: string }> {
  const cached = tscRunCache.get(ctx);
  if (cached && cached.lastHash === contentHash) {
    return cached.lastResult ? { ok: true } : { ok: false, firstError: '(cached)' };
  }
  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-squisq-`);
  try {
    await materializeWorkspace(client, projectId, tmp);
    const tsc = resolveTscBin();
    const result = await spawnAndAwait(process.execPath, [tsc, '--noEmit', '-p', tmp], {
      cwd: tmp,
      timeoutMs: 90_000,
    });
    const ok = result.exitCode === 0;
    if (!ok) {
      const firstError =
        result.stdout
          .split('\n')
          .find((l) => /error TS\d+:/i.test(l))
          ?.trim()
          .slice(0, 200) ?? '(no error line parsed)';
      log(`[scenario] tsc failed: ${firstError}`);
      tscRunCache.set(ctx, { lastHash: contentHash, lastResult: false });
      return { ok: false, firstError };
    }
    log(`[scenario] tsc passed (${result.durationMs} ms)`);
    tscRunCache.set(ctx, { lastHash: contentHash, lastResult: true });
    return { ok: true };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────
// Behavioral gate. The structural sniffs above are style-sensitive by
// nature (regexes over source); the authoritative check imports the
// model's actual code and asserts BEHAVIOR, which no loop idiom or
// helper-naming choice can bias. Node ≥ 22.6 type-strips the workspace
// `.ts` files natively, so the materialized tree is directly importable.

export interface BehavioralCheckResult {
  ok: boolean;
  why?: string;
}

export interface BehavioralChecks {
  greatCircle: BehavioralCheckResult;
  gracefulErrors: BehavioralCheckResult;
  deepValidation: BehavioralCheckResult;
}

const BEHAVIOR_MARKER = '__GEZEL_BEHAVIOR__';

/**
 * The probe geohashes straddle the antimeridian on the equator:
 * `xb0b` decodes to (0.088, 169.98) and `80p0` to (0.088, −169.98) —
 * ~2228 km apart along the great circle through ±180. The buggy linear
 * interpolation instead walks lng 170 → −170 the long way through 0.
 */
const BEHAVIOR_CHECK_MJS = `
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// The seeded tsconfig uses bundler resolution, so relative extensionless and
// .js specifiers can resolve to .ts source. Raw Node type stripping is stricter.
// Mirror that one rule only when the candidate .ts file actually exists.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL) {
      const candidate = /\\.(?:js|mjs|cjs)$/.test(specifier)
        ? specifier.replace(/\\.(?:js|mjs|cjs)$/, '.ts')
        : /\\.(?:ts|mts|cts)$/.test(specifier)
          ? null
          : specifier + '.ts';
      if (candidate) {
        const candidateUrl = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(candidateUrl))) {
          return nextResolve(candidate, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const out = {};
function check(name, fn) {
  try { fn(); out[name] = { ok: true }; }
  catch (err) { out[name] = { ok: false, why: String((err && err.message) || err).slice(0, 300) }; }
}
let geo = null;
let per = null;
let geoImportErr = null;
let perImportErr = null;
try { geo = await import('./packages/core/src/spatial/Geohash.ts'); }
catch (err) { geoImportErr = String((err && err.message) || err).slice(0, 300); }
try { per = await import('./packages/core/src/imageEdit/persistence.ts'); }
catch (err) { perImportErr = String((err && err.message) || err).slice(0, 300); }

if (geo) {
  check('gracefulErrors', () => {
    const n = geo.getGeohash4Neighbors('xx');
    if (!Array.isArray(n) || n.length !== 0) {
      throw new Error('getGeohash4Neighbors("xx") must return [] for bad-length input (got ' + JSON.stringify(n) + ')');
    }
    const p = geo.geohashToHierarchicalPath('xx');
    if (p !== '') {
      throw new Error('geohashToHierarchicalPath("xx") must return "" for bad-length input (got ' + JSON.stringify(p) + ')');
    }
    const n4 = geo.getGeohash4Neighbors('u1hx');
    if (!Array.isArray(n4) || n4.length !== 4 || n4.some((h) => typeof h !== 'string' || h.length === 0)) {
      throw new Error('getGeohash4Neighbors("u1hx") broke for VALID input — must still return 4 neighbor hashes');
    }
    const p4 = geo.geohashToHierarchicalPath('u1hx');
    if (p4 !== 'u/u1/u1h/u1hx') {
      throw new Error('geohashToHierarchicalPath("u1hx") broke for VALID input (got ' + JSON.stringify(p4) + ', want "u/u1/u1h/u1hx")');
    }
  });
  check('greatCircle', () => {
    const path = geo.getGeohashPath('xb0b', '80p0');
    if (!Array.isArray(path) || path.length < 50) {
      throw new Error('getGeohashPath sampled only ' + (Array.isArray(path) ? path.length : typeof path) + ' points across ~2228 km — steps must derive from the true great-circle distance (~149 at 15 km/step)');
    }
    const bad = path.find((pt) => pt && typeof pt.lng === 'number' && Math.abs(pt.lng) < 90);
    if (bad) {
      throw new Error('path from lng 170 to lng -170 passes through lng ' + bad.lng.toFixed(1) + ' — it must cross the antimeridian (\\u00b1180), not run back through 0');
    }
  });
} else {
  out.gracefulErrors = { ok: false, why: 'Geohash.ts failed to import: ' + geoImportErr };
  out.greatCircle = { ok: false, why: 'Geohash.ts failed to import: ' + geoImportErr };
}

if (per) {
  check('deepValidation', () => {
    const valid = { version: 1, canvas: { width: 100, height: 100 }, layers: [{ id: 'a', type: 'image', x: 0, y: 0 }] };
    per.assertImageEditDoc(valid); // must NOT throw
    const bads = [
      ['a null layer', { version: 1, canvas: { width: 1, height: 1 }, layers: [null] }],
      ['a non-string id', { version: 1, canvas: { width: 1, height: 1 }, layers: [{ id: 42, type: 'image', x: 0, y: 0 }] }],
      ['an invalid type', { version: 1, canvas: { width: 1, height: 1 }, layers: [{ id: 'a', type: 'nope', x: 0, y: 0 }] }],
      ['missing numeric x/y', { version: 1, canvas: { width: 1, height: 1 }, layers: [{ id: 'a', type: 'image' }] }],
    ];
    for (const [label, doc] of bads) {
      let threw = false;
      try { per.assertImageEditDoc(doc); } catch { threw = true; }
      if (!threw) throw new Error('assertImageEditDoc accepted a doc whose layers contain ' + label + ' — per-layer validation is missing or shallow');
    }
  });
} else {
  out.deepValidation = { ok: false, why: 'persistence.ts failed to import: ' + perImportErr };
}

console.log('${BEHAVIOR_MARKER}' + JSON.stringify(out));
`;

/** The grader probe plus a gate-friendly exit status and named failures. */
export const FIX_SQUISQ_TRUSTED_CHECK_SOURCE = `${BEHAVIOR_CHECK_MJS.replaceAll(
  "import('./packages/",
  "import('../packages/",
)}
const failedChecks = Object.entries(out).filter(([, result]) => !result || !result.ok);
if (failedChecks.length > 0) {
  console.error('FAIL ' + failedChecks.length + '/3 trusted behavioral checks');
  for (const [name, result] of failedChecks) {
    console.error('- ' + name + ': ' + ((result && result.why) || 'check failed'));
  }
  process.exitCode = 1;
} else {
  console.log('PASS 3/3 trusted behavioral checks');
}
`;

const behaviorRunCache = new WeakMap<
  EvalContext,
  { lastHash: string; lastResult: BehavioralChecks | null }
>();

/**
 * Run the behavioral assertions against a materialized copy of the
 * workspace. Returns null when the harness itself failed (spawn error,
 * timeout, unparseable output) — callers fall back to the structural
 * sniffs in that case rather than failing the trial on harness trouble.
 */
export async function runBehavioralChecksInDir(dir: string): Promise<BehavioralChecks | null> {
  const scriptPath = join(dir, '__gezel_behavior_check.mjs');
  await fsWriteFile(scriptPath, BEHAVIOR_CHECK_MJS, 'utf8');
  try {
    const result = await spawnAndAwait(process.execPath, ['--no-warnings', scriptPath], {
      cwd: dir,
      timeoutMs: 30_000,
    });
    const line = result.stdout.split('\n').find((l) => l.startsWith(BEHAVIOR_MARKER));
    if (!line) return null;
    const parsed = JSON.parse(line.slice(BEHAVIOR_MARKER.length)) as BehavioralChecks;
    if (!parsed.greatCircle || !parsed.gracefulErrors || !parsed.deepValidation) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
  }
}

/**
 * Offline verification of a fix-squisq workspace DIRECTORY (no daemon):
 * behavioral checks + haversine-untouched + tsc. Used by the
 * failure-class backfill to re-judge historical trials against the
 * current (style-blind) gates — a failed trial whose final workspace
 * verifies here was false-failed by the old grader. Run it on a COPY:
 * the behavioral runner drops a temp script into the directory.
 */
export async function verifyFixSquisqWorkspaceDir(dir: string): Promise<{
  checks: BehavioralChecks | null;
  behaviorallyFixed: boolean;
  haversineUntouched: boolean;
  tscClean: boolean | null;
}> {
  const checks = await runBehavioralChecksInDir(dir);
  const behaviorallyFixed = Boolean(
    checks?.greatCircle.ok && checks.gracefulErrors.ok && checks.deepValidation.ok,
  );
  let haversineUntouched = false;
  try {
    const { readFile } = await import('node:fs/promises');
    const haversine = await readFile(join(dir, HAVERSINE_PATH), 'utf8');
    haversineUntouched = detectHaversineUntouched(haversine);
  } catch {
    haversineUntouched = false;
  }
  let tscClean: boolean | null = null;
  if (behaviorallyFixed && haversineUntouched) {
    try {
      const tsc = resolveTscBin();
      const result = await spawnAndAwait(process.execPath, [tsc, '--noEmit', '-p', dir], {
        cwd: dir,
        timeoutMs: 90_000,
      });
      tscClean = result.exitCode === 0;
    } catch {
      tscClean = null;
    }
  }
  return { checks, behaviorallyFixed, haversineUntouched, tscClean };
}

async function runBehavioralChecks(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  contentHash: string,
  log: (line: string) => void,
): Promise<BehavioralChecks | null> {
  const cached = behaviorRunCache.get(ctx);
  if (cached && cached.lastHash === contentHash) return cached.lastResult;
  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-squisq-behavior-`);
  try {
    await materializeWorkspace(client, projectId, tmp);
    const checks = await runBehavioralChecksInDir(tmp);
    if (checks === null) {
      log(
        '[scenario] behavioral checks unavailable (harness error) — falling back to structural sniffs',
      );
    } else {
      log(
        `[scenario] behavioral checks: greatCircle=${checks.greatCircle.ok} graceful=${checks.gracefulErrors.ok} deepValidation=${checks.deepValidation.ok}`,
      );
    }
    behaviorRunCache.set(ctx, { lastHash: contentHash, lastResult: checks });
    return checks;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export const fixSquisqBugsScenario: EvalScenario = {
  id: 'fix-squisq-bugs',
  description:
    'Find-and-fix three documented bugs in a seeded squisq core subset: great-circle geohash path, recursive ImageEditDoc layer validation, and graceful empty-return (no throw) on bad geohash input — without breaking `tsc --noEmit`.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is fixing three documented bugs in the "${PROJECT_NAME}" project`,
    '(see bug_report.md + the seeded source). You do not need to do anything — just confirm',
    "you've seen this note.",
  ].join(' '),
  // Three localized edits across two files + reads. Generous for a small
  // local model that reads-and-re-reads; gemma4-e4b is expected to
  // struggle on the multi-bug planning, which is the point of the run.
  // 25 min (was 35): the re-baseline showed failing trials
  // riding the full ceiling in active-but-not-converging loops — every
  // observed pass landed well under 10 min, so the last 10 minutes only
  // bought wall-clock cost, never verdict changes. Large-model runner
  // overrides still raise this via minTrialTimeoutMs.
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] squisq-core project not present yet');
      return { done: false };
    }

    const [geohashTs, haversineTs, persistenceTs] = await Promise.all([
      readWorkspaceText(client, projectId, GEOHASH_PATH),
      readWorkspaceText(client, projectId, HAVERSINE_PATH),
      readWorkspaceText(client, projectId, PERSISTENCE_PATH),
    ]);

    // Behavioral checks are AUTHORITATIVE for the three fix signals when
    // the harness can run (it imports the model's code and asserts what
    // it DOES). The structural sniffs below are the fallback when the
    // behavioral harness itself errors, and historically the only gate —
    // which made the scenario style-sensitive (see detectDeepValidation's
    // doc comment for the qwen3.6 index-loop false-negative incident).
    let behavioral: BehavioralChecks | null = null;
    if (geohashTs !== null && persistenceTs !== null) {
      const behaviorHash = `${geohashTs.length.toString(36)}.${persistenceTs.length.toString(36)}.${simpleHash(geohashTs)}.${simpleHash(persistenceTs)}`;
      behavioral = await runBehavioralChecks(ctx, client, projectId, behaviorHash, log);
    }

    const signals: string[] = [];
    const failures: string[] = [];

    const greatCircleOk = behavioral ? behavioral.greatCircle.ok : detectGreatCirclePath(geohashTs);
    if (greatCircleOk) signals.push('great-circle-path');
    else if (geohashTs !== null)
      failures.push(
        behavioral?.greatCircle.why
          ? `getGeohashPath behavioral check failed: ${behavioral.greatCircle.why}`
          : 'getGeohashPath still linear-interpolates lat/lng (needs great-circle / spherical sampling)',
      );

    const gracefulOk = behavioral ? behavioral.gracefulErrors.ok : detectGracefulErrors(geohashTs);
    if (gracefulOk) signals.push('graceful-errors');
    else if (geohashTs !== null)
      failures.push(
        behavioral?.gracefulErrors.why
          ? `graceful-errors behavioral check failed: ${behavioral.gracefulErrors.why}`
          : "getGeohash4Neighbors / geohashToHierarchicalPath still throw on bad input (need return [] / '')",
      );

    const deepValidationOk = behavioral
      ? behavioral.deepValidation.ok
      : detectDeepValidation(persistenceTs);
    if (deepValidationOk) signals.push('deep-layer-validation');
    else if (persistenceTs !== null)
      failures.push(
        behavioral?.deepValidation.why
          ? `assertImageEditDoc behavioral check failed: ${behavioral.deepValidation.why}`
          : 'assertImageEditDoc does not recursively validate each layer yet',
      );

    if (detectHaversineUntouched(haversineTs)) signals.push('haversine-untouched');
    else if (haversineTs !== null)
      failures.push('Haversine.ts was modified — it should be left exactly as seeded');

    // tsc-clean is the guard that edits didn't break the subset. Run it
    // only once the three fix signals are present (tsc is expensive).
    const fixesComplete =
      signals.includes('great-circle-path') &&
      signals.includes('graceful-errors') &&
      signals.includes('deep-layer-validation') &&
      signals.includes('haversine-untouched');

    let tscOk = false;
    if (fixesComplete) {
      const contentHash = `${(geohashTs ?? '').length.toString(36)}.${(persistenceTs ?? '').length.toString(36)}.${simpleHash(geohashTs ?? '')}.${simpleHash(persistenceTs ?? '')}`;
      const tsc = await runTsc(ctx, client, projectId, contentHash, log);
      tscOk = tsc.ok;
      if (tscOk) signals.push('tsc-clean');
      else if (tsc.firstError) failures.push(`tsc-clean failed: ${tsc.firstError}`);
    }

    const totalBytes = (geohashTs?.length ?? 0) + (persistenceTs?.length ?? 0);
    const score = signals.length;
    const failReason = failures.length > 0 ? failures[0] : undefined;

    logChanged(
      'sniff',
      `[scenario] fix-squisq-bugs bytes=${totalBytes} score=${score}/${FIX_SIGNAL_NAMES.length} signals=${signals.join(',') || 'none'}${failReason ? ` failReason="${failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'fix-squisq-bugs', score, bytes: totalBytes });

    if (tscOk && score >= FIX_SIGNAL_NAMES.length) {
      return {
        done: true,
        success: true,
        reason: `all ${FIX_SIGNAL_NAMES.length} signals firing including tsc-clean (${signals.join(', ')})`,
      };
    }

    if (failReason) {
      const missing = FIX_SIGNAL_NAMES.filter((s) => !signals.includes(s));
      // Route the failure to the developer so the model has something
      // concrete to act on rather than iterating blind.
      const target = fixSquisqFeedbackTarget(failReason, signals);
      await postSniffFeedback(ctx, target, {
        ok: false,
        signals,
        score,
        failReason,
        missingRequiredSignals: missing,
      });
    }
    return { done: false };
  },
};
