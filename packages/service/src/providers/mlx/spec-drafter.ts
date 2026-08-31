/**
 * Where an MTP drafter lives, and what it costs to keep resident.
 *
 * Speculative decoding is on by default, but "on" can only mean "on when a
 * drafter for this model is actually present": the drafter is a separate
 * ~0.8 GB artifact split out of an MTP-preserving source checkpoint, and no
 * MLX conversion carries the `mtp.*` tensors it is made of (mlx-lm's
 * `sanitize()` strips them). So the launcher looks beside the model tree
 * instead of requiring configuration, and a model with no drafter simply
 * serves normally — the sidecar's probe logs one `[spec] off` line and the
 * turn takes the ordinary path.
 *
 * Convention: `<engines>/mlx/drafters/<modelDirName>-mtp`, a sibling of
 * `<engines>/mlx/models/<modelDirName>`. Keyed on the model directory, not a
 * base-model guess, because string-surgering a quantization suffix off an id
 * is how a drafter ends up silently paired with the wrong checkpoint. A
 * drafter genuinely shared across quantizations of one base model is a
 * symlink (or an explicit `mlxSpecDraftModelPath`), which keeps the sharing
 * decision the operator's rather than a parser's.
 *
 * The bytes matter as much as the path. MLX slot planning reserves memory
 * from the target's weights, and an unpriced second resident model is
 * exactly the over-commit that makes a Metal command-buffer OOM abort the
 * whole python process. `drafterBytes` feeds the same weights figure the
 * ceiling math already uses.
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Sidecar-visible drafter selection, or null when speculation stays off. */
export interface SpecDrafterPlan {
  /** Absolute path passed to the sidecar as `--spec-draft-model`. */
  dir: string;
  /** On-disk size, added to the resident-weights figure for memory planning. */
  bytes: number;
  /** Why this drafter was chosen — for the launch log. */
  source: 'configured' | 'convention';
}

/** Directory name a model's drafter is expected to occupy. */
export function drafterDirFor(modelDir: string): string {
  return resolve(modelDir, '..', '..', 'drafters', `${basename(modelDir)}-mtp`);
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      total += directorySize(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    total += statSync(join(dir, entry.name)).size;
  }
  return total;
}

/**
 * Resolve the drafter for a model build.
 *
 * `configured` wins outright (an operator pointing at a shared or
 * hand-built drafter), otherwise the convention path is used when it
 * exists. Returns null when speculation is disabled or nothing is present.
 * Never throws: an unreadable drafter directory is a reason to serve
 * normally, not a reason to fail a launch.
 */
export function resolveSpecDrafter(opts: {
  modelDir?: string;
  configuredPath?: string | null;
  enabled?: boolean | null;
}): SpecDrafterPlan | null {
  if (opts.enabled === false) return null;
  const candidate = opts.configuredPath?.trim()
    ? { dir: opts.configuredPath.trim(), source: 'configured' as const }
    : opts.modelDir
      ? { dir: drafterDirFor(opts.modelDir), source: 'convention' as const }
      : null;
  if (!candidate) return null;
  try {
    if (!statSync(candidate.dir).isDirectory()) return null;
    return { ...candidate, bytes: directorySize(candidate.dir) };
  } catch {
    return null;
  }
}
