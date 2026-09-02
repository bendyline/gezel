import { z } from 'zod';
import { PoppetjeSchema } from '../poppetje/schema.js';

/**
 * ─ Run recording (`recording/transcript.json`) ───────────────────────
 *
 * The distilled, replayable record of one multi-gezel run: an ordered
 * list of SCENES (user prompts, reasoning, tool calls, delegations,
 * step transitions, gate verdicts, artifact reveals) with absolute
 * timestamps and the ACTORS (gezels, with their poppetje structs) who
 * produced them. Written by the eval harness for every trial
 * (`evals/src/recording/`) and — with `provenance` stamped — published
 * into the gilde catalog as a craftbook's demo recording sidecar.
 *
 * Deliberately squisq-independent: this is the capture/publish contract;
 * the UI's movies module (`packages/ui/src/movies/`) maps it to a squisq
 * Doc for playback. Media
 * references (`refs`, `screenshots[].file`) are paths RELATIVE TO THE
 * TRANSCRIPT'S OWN DIRECTORY, so a recording folder is portable between
 * a run dir, a gilde item, and a site export.
 *
 * Size discipline: the ≤1 MB target for a publishable transcript is
 * DISTILLER POLICY (excerpt caps, scene ceilings, importance-tiered
 * downsampling recorded in `budget`), not schema — the schema stays
 * permissive so a debug-grade recording can be richer.
 */

/** Current schema version — bump only on a breaking shape change. */
export const RUN_RECORDING_SCHEMA_VERSION = 1;

/** Directory a craftbook's published recording lives in (item level). */
export const CRAFTBOOK_RECORDING_DIRNAME = 'recording';
/** Item-relative path of a craftbook's published transcript. */
export const CRAFTBOOK_RECORDING_FILENAME = 'recording/transcript.json';
/**
 * Item-relative path of the fixed-name hero still. The name is
 * load-bearing: catalog `list()` exposes a poster URL from two cheap
 * fs stats instead of parsing every transcript on the hot list path.
 */
export const CRAFTBOOK_RECORDING_POSTER = 'recording/poster.webp';

// ── Actors ───────────────────────────────────────────────────────────

export const RunRecordingActorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().optional(),
    kind: z.enum(['gezel', 'user', 'system']),
    meester: z.boolean().optional(),
    /**
     * The gezel's resolved carved-figure struct, captured at record time
     * so the movie renders the cast as they looked during the run even
     * if the gezel is later rerolled or deleted.
     */
    poppetje: PoppetjeSchema.optional(),
  })
  .strict();
export type RunRecordingActor = z.infer<typeof RunRecordingActorSchema>;

// ── Scenes ───────────────────────────────────────────────────────────

/**
 * Media/source pointers shared by every scene kind. All file paths are
 * relative to the transcript's directory; `sessionFile`/`messageIndex`
 * point back into a run dir's `sessions/` capture for debug drill-down
 * and are meaningless (omitted) in a published craftbook recording.
 */
const SceneRefsSchema = z
  .object({
    screenshot: z.string().optional(),
    artifact: z.string().optional(),
    sessionFile: z.string().optional(),
    messageIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RunRecordingSceneRefs = z.infer<typeof SceneRefsSchema>;

const sceneBase = {
  /** ISO timestamp of the moment this scene began. */
  at: z.string().min(1),
  /** Who did it — an id from `actors[]`. Absent for harness/system beats. */
  actorId: z.string().optional(),
  sessionId: z.string().optional(),
  taskRef: z.string().optional(),
  /** Bounded human-readable payload text (distiller-capped). */
  excerpt: z.string().optional(),
  refs: SceneRefsSchema.optional(),
} as const;

export const RunRecordingSceneSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-prompt'), ...sceneBase }).strict(),
  z
    .object({
      kind: z.literal('reasoning'),
      ...sceneBase,
      durationMs: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-call'),
      ...sceneBase,
      name: z.string().min(1),
      argsSummary: z.string().optional(),
      success: z.boolean(),
      durationMs: z.number().nonnegative().optional(),
      path: z.string().optional(),
      /** >1 when consecutive same-name calls were coalesced into one scene. */
      count: z.number().int().positive().optional(),
      diffStats: z
        .object({
          addedLines: z.number().int().nonnegative(),
          removedLines: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('reply'), ...sceneBase }).strict(),
  z
    .object({
      kind: z.literal('delegation'),
      ...sceneBase,
      /** Sender is `actorId`/`sessionId`; this is the receiving side. */
      toActorId: z.string().min(1),
      toSessionId: z.string().optional(),
      delegationKind: z
        .enum(['delegation', 'consultation', 'task-entry', 'task-handoff'])
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('step-transition'),
      ...sceneBase,
      stepId: z.string().min(1),
      stepName: z.string().optional(),
      phase: z.enum(['activated', 'completed', 'gated', 'redriven', 'stalled']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gate-verdict'),
      ...sceneBase,
      stepId: z.string().optional(),
      verdict: z.enum(['pass', 'fail']),
      attempt: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact-produced'),
      ...sceneBase,
      store: z.enum(['workspace', 'artifact']),
      path: z.string().min(1),
      bytes: z.number().int().nonnegative().optional(),
      /** Transcript-dir-relative screenshot of the produced file. */
      screenshotRef: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('question'),
      ...sceneBase,
      state: z.enum(['asked', 'answered']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('turn-aborted'),
      ...sceneBase,
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('note'),
      ...sceneBase,
      stepId: z.string().optional(),
    })
    .strict(),
]);
export type RunRecordingScene = z.infer<typeof RunRecordingSceneSchema>;
export type RunRecordingSceneKind = RunRecordingScene['kind'];

// ── Recording ────────────────────────────────────────────────────────

/** Eval-trial identity — present on run-dir recordings, absent in gilde. */
export const RunRecordingTrialSchema = z
  .object({
    trialId: z.string().min(1),
    scenarioId: z.string().min(1),
    modelId: z.string().min(1),
    startedAt: z.string().min(1),
    durationMs: z.number().nonnegative().optional(),
    success: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type RunRecordingTrial = z.infer<typeof RunRecordingTrialSchema>;

/**
 * Publish provenance — REQUIRED on a craftbook's gilde sidecar. The
 * version + spec-hash stamp is what makes staleness computable at read
 * time: a recording keeps playing after the craftbook revs, but every
 * surface can say "recorded against v1.0.0" and gilde CI can warn on
 * the PR that made it stale. `testSpecHash` is `canonicalTestSpecHash`
 * over the version's `test.json` (canonical JSON, so formatter churn
 * never false-flags), deliberately NOT named `sha256` — gilde
 * validate's deep-scan sha256 rule must not apply to it.
 */
export const RunRecordingProvenanceSchema = z
  .object({
    craftbookId: z.string().min(1),
    craftbookVersion: z.string().min(1),
    testSpecHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    modelId: z.string().min(1),
    recordedAt: z.string().min(1),
    durationMs: z.number().nonnegative().optional(),
    title: z.string().optional(),
    /** One-liner used for captions/cover copy. */
    summary: z.string().optional(),
  })
  .strict();
export type RunRecordingProvenance = z.infer<typeof RunRecordingProvenanceSchema>;

export const RunRecordingScreenshotSchema = z
  .object({
    /** Transcript-dir-relative file (no `..`, no absolute paths). */
    file: z
      .string()
      .min(1)
      .refine(
        (value) => !value.includes('..') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value),
        {
          message: 'file must be a transcript-dir-relative path',
        },
      ),
    caption: z.string().optional(),
    sceneId: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export type RunRecordingScreenshot = z.infer<typeof RunRecordingScreenshotSchema>;

/** What the distiller dropped to hit its size budget — honesty metadata. */
export const RunRecordingBudgetSchema = z
  .object({
    droppedScenes: z.number().int().nonnegative(),
    truncatedExcerpts: z.number().int().nonnegative(),
  })
  .strict();
export type RunRecordingBudget = z.infer<typeof RunRecordingBudgetSchema>;

export const RunRecordingSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    trial: RunRecordingTrialSchema.optional(),
    provenance: RunRecordingProvenanceSchema.optional(),
    actors: z.array(RunRecordingActorSchema),
    scenes: z.array(RunRecordingSceneSchema),
    screenshots: z.array(RunRecordingScreenshotSchema).optional(),
    budget: RunRecordingBudgetSchema,
    /** Opaque escape hatch, same stance as CraftbookTestSpec.extensions. */
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RunRecording = z.infer<typeof RunRecordingSchema>;

/**
 * The gilde sidecar shape: a RunRecording whose `provenance` is present.
 * Same wire format — a run-dir transcript becomes publishable by
 * stamping provenance, nothing else changes.
 */
export const CraftbookRecordingSchema = RunRecordingSchema.extend({
  provenance: RunRecordingProvenanceSchema,
});
export type CraftbookRecording = z.infer<typeof CraftbookRecordingSchema>;

// ── Capture manifest (`recording/manifest.json` in a run dir) ────────

/**
 * Written by the eval recorder at trial finalize: what was captured,
 * what failed, and where the chat-event log has gaps. Every section is
 * best-effort — a failed section is recorded here, never a failed trial.
 */
export const RunRecordingManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    trialId: z.string().min(1),
    scenarioId: z.string().min(1),
    modelId: z.string().min(1),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    /** Run-dir-relative paths of the capture files that were written. */
    files: z.record(z.string(), z.string()).optional(),
    chatEvents: z
      .object({
        lines: z.number().int().nonnegative(),
        coalescedDeltas: z.number().int().nonnegative().optional(),
        gaps: z.array(z.object({ from: z.string(), to: z.string() }).strict()).optional(),
        truncated: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Per-section capture status ('ok' | 'failed: <reason>'). */
    capture: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type RunRecordingManifest = z.infer<typeof RunRecordingManifestSchema>;

// ── Parsing ──────────────────────────────────────────────────────────

export interface ParseRunRecordingOptions {
  /**
   * `strict` (authoring/CI/pipeline emit): unknown keys and future
   * schema versions are errors. `tolerant` (runtime readers — catalog,
   * viewers): unknown keys are stripped and any
   * `schemaVersion <= RUN_RECORDING_SCHEMA_VERSION` is accepted, so an
   * older reader survives a recording written by a newer producer.
   * Unknown scene KINDS are structural (the discriminator), so tolerant
   * readers additionally drop scenes whose kind they don't know rather
   * than failing the whole recording.
   */
  mode?: 'strict' | 'tolerant';
  /** Require `provenance` (the gilde sidecar contract). */
  requireProvenance?: boolean;
}

export type ParseRunRecordingResult =
  | { ok: true; recording: RunRecording; droppedUnknownScenes: number }
  | { ok: false; errors: string[] };

const KNOWN_SCENE_KINDS = new Set<string>([
  'user-prompt',
  'reasoning',
  'tool-call',
  'reply',
  'delegation',
  'step-transition',
  'gate-verdict',
  'artifact-produced',
  'question',
  'turn-aborted',
  'note',
]);

/**
 * Parse a raw `transcript.json` payload. Never throws — CI, the catalog
 * accessor, and viewers all want the error list, not an exception.
 */
export function parseRunRecording(
  raw: unknown,
  opts?: ParseRunRecordingOptions,
): ParseRunRecordingResult {
  const mode = opts?.mode ?? 'strict';
  let droppedUnknownScenes = 0;
  let candidate = raw;
  if (mode === 'tolerant') {
    candidate = structuredClone(raw);
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      const version = record.schemaVersion;
      if (
        typeof version === 'number' &&
        Number.isInteger(version) &&
        version > RUN_RECORDING_SCHEMA_VERSION
      ) {
        record.schemaVersion = RUN_RECORDING_SCHEMA_VERSION;
      }
      if (Array.isArray(record.scenes)) {
        const kept = record.scenes.filter(
          (scene) =>
            scene !== null &&
            typeof scene === 'object' &&
            KNOWN_SCENE_KINDS.has(String((scene as Record<string, unknown>).kind)),
        );
        droppedUnknownScenes = record.scenes.length - kept.length;
        record.scenes = kept;
      }
    }
    candidate = deepStripUnknown(candidate);
  }
  const parsed = RunRecordingSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
        return `${path}: ${issue.message}`;
      }),
    };
  }
  if (opts?.requireProvenance && !parsed.data.provenance) {
    return { ok: false, errors: ['provenance: required for a published craftbook recording'] };
  }
  return { ok: true, recording: parsed.data, droppedUnknownScenes };
}

/**
 * Tolerant pre-pass, mirroring craftbook-test.ts: retry-parse after
 * removing keys strict mode rejected. Structural errors still fail —
 * tolerance covers ADDITIVE change only.
 */
function deepStripUnknown(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  for (let pass = 0; pass < 16; pass++) {
    const attempt = RunRecordingSchema.safeParse(record);
    if (attempt.success) return record;
    const unknownKeyIssues = attempt.error.issues.filter(
      (issue) => issue.code === z.ZodIssueCode.unrecognized_keys,
    );
    if (unknownKeyIssues.length === 0) return record;
    for (const issue of unknownKeyIssues) {
      const target = resolvePath(record, issue.path);
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        for (const key of issue.keys) delete (target as Record<string, unknown>)[key];
      }
    }
  }
  return record;
}

function resolvePath(root: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[segment];
  }
  return node;
}
