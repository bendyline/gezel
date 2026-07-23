import type { GezelClient } from '@bendyline/gezel-client/node';
import {
  loadCorpusManifest,
  materializeCorpus,
  seedCorpusIntoProject,
} from '../index-bench/corpus.ts';
import { maybeWarmProject } from '../index-bench/warm.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Broad-refactor probe on the pinned squisq corpus: rename a function that
 * 34 files reference, everywhere. The task is mechanically simple but wide —
 * exactly the shape where index-backed retrieval (find every reference
 * first) beats readFile-walking. Run via `ab-index` in warm vs cold arms.
 *
 * Grader is hermetic rg-accounting over the trial workspace via the
 * server-side `search-files` tool (no npm, no network):
 *   1. zero `\boldName\b` left in ts/tsx/md (word boundary — `newName`
 *      contains `oldName` as a prefix, so the boundary is load-bearing),
 *   2. ≥ minRenamedFiles files contain `\bnewName\b` (kills delete/comment-
 *      out cheats),
 *   3. the defining file still exports the new name (with 1, kills
 *      alias-shims),
 *   4. corpus file count roughly unchanged.
 */

const QUESTION_GLOB = '**/*.{ts,tsx,md}';

interface RefactorState {
  projectId: string;
  seeded: number;
  oldName: string;
  newName: string;
  defFile: string;
  minRenamedFiles: number;
}

// Module-level, not WeakMap<EvalContext>: the runner hands setup and
// successCheck different ctx objects; trials run sequentially in-process.
let currentState: RefactorState | null = null;

async function countMatchFiles(
  client: GezelClient,
  projectId: string,
  pattern: string,
): Promise<{ files: number; paths: string[] }> {
  const res = await client.toolSearchFiles(projectId, {
    pattern,
    glob: QUESTION_GLOB,
  });
  const paths = [...new Set(res.matches.map((m) => m.path))];
  return { files: paths.length, paths };
}

async function setup(ctx: EvalContext): Promise<void> {
  currentState = null;
  const { client, log } = ctx;
  const manifest = await loadCorpusManifest(process.env.GEZEL_INDEX_BENCH_CORPUS ?? 'squisq');
  const corpusDir = await materializeCorpus(manifest);
  const project = await client.createProject({
    name: 'squisq-refactor',
    about:
      'A pinned subset of the squisq markdown/document library (core, formats, react packages). TypeScript, npm workspaces.',
    missionObjectives: 'Keep the library consistent and compiling while evolving its API.',
  });
  const { seeded } = await seedCorpusIntoProject(client, project.id, corpusDir, { log });
  await maybeWarmProject(ctx, project.id);

  const dev = await client.createGezel({ name: 'Renske', role: 'Developer' }).catch(async () => {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === 'Renske');
    if (!existing) throw new Error('failed to create developer gezel');
    return existing;
  });

  const r = manifest.refactor;
  currentState = {
    projectId: project.id,
    seeded,
    oldName: r.oldName,
    newName: r.newName,
    defFile: r.defFile,
    minRenamedFiles: r.minRenamedFiles,
  };

  await client.sendChatMessage(dev.id, {
    projectId: project.id,
    message: `Rename the function \`${r.oldName}\` to \`${r.newName}\` across the ENTIRE workspace — every import, call site, re-export, type reference, comment, doc mention, and string that refers to it. It is defined in \`${r.defFile}\` and referenced in roughly ${r.refFileCount} files across core/, formats/, and react/. Do not change any behavior, do not delete or add files, and do not leave a compatibility alias — when you are done, \`${r.oldName}\` must not appear anywhere and \`${r.newName}\` must be exported from the same file. Work through the whole workspace; a partial rename is a failed task.`,
  });
  log(`[refactor] kickoff sent for ${r.oldName} → ${r.newName} in project ${project.id}`);
}

export const squisqBroadRefactorScenario: EvalScenario = {
  id: 'squisq-broad-refactor',
  description:
    'Wide mechanical rename (34 files) on the pinned squisq corpus — the index-leverage refactor probe. Hermetic rg-accounting grader; run warm-vs-cold via ab-index.',
  prompt: 'Kickoff is sent directly to the developer in setup; this prompt is never sent.',
  skipInitialPrompt: true,
  timeoutMs: 4 * 60 * 60_000,
  setup,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const s = currentState;
    if (!s) return { done: true, success: false, reason: 'setup did not run' };
    const { client, logChanged } = ctx;

    // Cheap gate each poll: any old-name references left?
    const oldRefs = await countMatchFiles(client, s.projectId, `\\b${s.oldName}\\b`);
    logChanged('old-refs', `[refactor] files still referencing ${s.oldName}: ${oldRefs.files}`);
    if (oldRefs.files > 0) return { done: false };

    const newRefs = await countMatchFiles(client, s.projectId, `\\b${s.newName}\\b`);
    if (newRefs.files < s.minRenamedFiles) {
      logChanged(
        'new-refs',
        `[refactor] ${s.newName} present in only ${newRefs.files}/${s.minRenamedFiles} required files`,
      );
      // Old name gone but new name missing at scale → deletion/gutting, not
      // a rename. Give the model time to finish rather than failing early;
      // the timeout is the backstop.
      return { done: false };
    }

    const def = await client.readProjectWorkspaceFile(s.projectId, s.defFile).catch(() => null);
    const exportsNew =
      def !== null &&
      new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${s.newName}\\b`).test(def.content);
    if (!exportsNew) {
      return {
        done: true,
        success: false,
        reason: `rename radius reached but ${s.defFile} no longer exports ${s.newName}`,
      };
    }

    const files = await client.listProjectWorkspace(s.projectId, undefined, true);
    const fileCount = files.files.filter((f) => !f.isDirectory).length;
    if (Math.abs(fileCount - s.seeded) > 2) {
      return {
        done: true,
        success: false,
        reason: `workspace file count drifted (${s.seeded} seeded → ${fileCount}) — files were added/deleted`,
      };
    }

    return {
      done: true,
      success: true,
      reason: `${s.oldName} fully renamed: 0 stale refs, ${s.newName} in ${newRefs.files} files, export intact`,
    };
  },
};
