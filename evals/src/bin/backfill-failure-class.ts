/**
 * Backfill failure-class tags over historical eval runs.
 *
 * Walks every trial dir (anything holding a result.json) under the runs
 * directory and writes a `failure-class.json` sidecar with the
 * who-broke-it classification (`pass | model | infra | grader |
 * operator`) — see `failure-class.ts` for rules and motivation. The
 * original result.json is never modified.
 *
 * Grader-artifact detection re-judges the FINAL workspace snapshot
 * against the current (fixed) graders:
 *   - fix-squisq-bugs: copy the project workspace to a temp dir and run
 *     the behavioral checks + tsc. A failed trial that verifies clean was
 *     false-failed by the old style-sensitive sniff.
 *   - arcade-deluxe: re-run the static sniff with the ARCADE subject
 *     gate. A failed trial whose final HTML passes statically but failed
 *     the old tank-vocab REQUIRED gate was unwinnable. (Runtime
 *     assertions are not re-run offline — noted in the evidence.)
 *
 * Usage:
 *   tsx src/bin/backfill-failure-class.ts [--runs DIR] [--dry-run]
 */

import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyTrial, readDaemonLogTailSync } from '../failure-class.ts';
import type { FailureClassification } from '../failure-class.ts';
import { verifyFixSquisqWorkspaceDir } from '../scenarios/fix-squisq-bugs.ts';
import {
  ARCADE_SUBJECT_VOCAB,
  TANK_SUBJECT_VOCAB,
  tankCombatContentSniff,
} from '../success-check.ts';
import type { FailureClass, TrialResult } from '../types.ts';

const CLASSIFIER_VERSION = 1;

interface SidecarShape extends FailureClassification {
  trialId: string;
  scenarioId: string;
  modelId: string;
  classifierVersion: number;
  classifiedAt: string;
}

async function findResultFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDir: boolean }> = [];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDir) {
        if (e.name === 'node_modules' || e.name === 'workspace' || e.name === 'artifacts') {
          continue;
        }
        await walk(join(dir, e.name));
      } else if (e.name === 'result.json') {
        out.push(join(dir, e.name));
      }
    }
  }
  await walk(root);
  return out;
}

/** Find project dirs inside the trial's captured workspace snapshot. */
async function listWorkspaceProjectDirs(trialDir: string): Promise<string[]> {
  const ws = join(trialDir, 'workspace');
  try {
    const entries = await readdir(ws, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(ws, e.name));
  } catch {
    return [];
  }
}

async function findLargestHtml(dir: string): Promise<string | null> {
  let best: { path: string; size: number } | null = null;
  async function walk(d: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) await walk(p);
      else if (/\.html?$/i.test(name) && (best === null || s.size > best.size)) {
        best = { path: p, size: s.size };
      }
    }
  }
  await walk(dir);
  return best ? (best as { path: string; size: number }).path : null;
}

/** fix-squisq grader re-judgment: behaviorally verify the final workspace. */
async function detectFixSquisqGraderArtifact(
  trialDir: string,
): Promise<FailureClassification | null> {
  for (const projectDir of await listWorkspaceProjectDirs(trialDir)) {
    if (!existsSync(join(projectDir, 'packages/core/src/imageEdit/persistence.ts'))) continue;
    const tmp = await mkdtemp(`${tmpdir()}/squisq-backfill-`);
    try {
      await cp(projectDir, tmp, { recursive: true });
      const verdict = await verifyFixSquisqWorkspaceDir(tmp);
      if (verdict.behaviorallyFixed && verdict.haversineUntouched && verdict.tscClean === true) {
        return {
          failureClass: 'grader',
          rule: 'fix-squisq-style-sniff',
          evidence:
            'final workspace passes the current behavioral checks + tsc — the trial was ' +
            'false-failed by the old loop-idiom-sensitive deep-validation regex',
        };
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  return null;
}

/** arcade-deluxe grader re-judgment: re-sniff the final HTML with the
 * arcade subject gate in place of the unsatisfiable tank gate. */
async function detectArcadeGraderArtifact(trialDir: string): Promise<FailureClassification | null> {
  for (const projectDir of await listWorkspaceProjectDirs(trialDir)) {
    const htmlPath = await findLargestHtml(projectDir);
    if (!htmlPath) continue;
    let html: string;
    try {
      html = await readFile(htmlPath, 'utf8');
    } catch {
      continue;
    }
    const oldVerdict = tankCombatContentSniff(html, { subjectVocab: TANK_SUBJECT_VOCAB });
    const newVerdict = tankCombatContentSniff(html, { subjectVocab: ARCADE_SUBJECT_VOCAB });
    if (!oldVerdict.ok && newVerdict.ok) {
      return {
        failureClass: 'grader',
        rule: 'arcade-tank-vocab',
        evidence:
          'final HTML passes the static arcade sniff but failed the old tank-vocab REQUIRED ' +
          'gate (the prompt never asks for tanks); runtime assertions not re-run offline',
      };
    }
  }
  return null;
}

async function classifyTrialDir(trialDir: string, result: TrialResult): Promise<SidecarShape> {
  const daemonLog = readDaemonLogTailSync(join(trialDir, 'daemon.log'));
  let classification = classifyTrial({
    success: result.success,
    reason: result.reason,
    failureMode: result.failureMode ?? null,
    daemonLog,
  });
  // Grader re-judgment only where the model would otherwise be blamed —
  // operator/infra causes are more proximate even when the workspace
  // turns out to be correct.
  if (classification.failureClass === 'model') {
    let grader: FailureClassification | null = null;
    // Grader-artifact rules use a cutoff: they re-judge trials run BEFORE
    // the corresponding grader fix landed. Post-fix trials
    // already run the corrected graders, so a static-sniff flip there
    // means runtime assertions failed — a model failure, not a grader
    // artifact.
    const GRADER_FIX_DATE = Date.parse('2026-06-10T12:00:00Z');
    const ranBeforeFix = Date.parse(result.startedAt ?? '') < GRADER_FIX_DATE;
    if (ranBeforeFix && result.scenarioId === 'fix-squisq-bugs') {
      grader = await detectFixSquisqGraderArtifact(trialDir);
    } else if (ranBeforeFix && result.scenarioId === 'arcade-deluxe') {
      grader = await detectArcadeGraderArtifact(trialDir);
    }
    if (grader) classification = grader;
  }
  return {
    trialId: result.trialId,
    scenarioId: result.scenarioId,
    modelId: result.modelId,
    ...classification,
    classifierVersion: CLASSIFIER_VERSION,
    classifiedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let runsDir = existsSync('runs') ? 'runs' : 'evals/runs';
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runs') runsDir = args[++i] ?? '';
    else if (arg === '--dry-run') dryRun = true;
    else {
      process.stderr.write('usage: backfill-failure-class.ts [--runs DIR] [--dry-run]\n');
      process.exit(2);
    }
  }

  const resultFiles = await findResultFiles(runsDir);
  process.stdout.write(`found ${resultFiles.length} trials under ${runsDir}\n`);

  const byClass = new Map<FailureClass, number>();
  const byRule = new Map<string, number>();
  const byModel = new Map<
    string,
    { n: number; pass: number; model: number; infra: number; grader: number; operator: number }
  >();
  const graderTrials: string[] = [];

  for (const rf of resultFiles) {
    const trialDir = dirname(rf);
    let result: TrialResult;
    try {
      result = JSON.parse(await readFile(rf, 'utf8')) as TrialResult;
    } catch {
      continue;
    }
    const sidecar = await classifyTrialDir(trialDir, result);
    byClass.set(sidecar.failureClass, (byClass.get(sidecar.failureClass) ?? 0) + 1);
    if (sidecar.failureClass !== 'pass') {
      byRule.set(sidecar.rule, (byRule.get(sidecar.rule) ?? 0) + 1);
    }
    const model = result.modelId ?? 'unknown';
    const m = byModel.get(model) ?? {
      n: 0,
      pass: 0,
      model: 0,
      infra: 0,
      grader: 0,
      operator: 0,
    };
    m.n += 1;
    if (sidecar.failureClass === 'pass') m.pass += 1;
    else m[sidecar.failureClass] += 1;
    byModel.set(model, m);
    if (sidecar.failureClass === 'grader') graderTrials.push(trialDir);
    if (!dryRun) {
      await writeFile(
        join(trialDir, 'failure-class.json'),
        `${JSON.stringify(sidecar, null, 2)}\n`,
      );
    }
  }

  process.stdout.write('\n=== CLASS TOTALS ===\n');
  for (const [cls, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${cls.padEnd(9)} ${n}\n`);
  }
  process.stdout.write('\n=== FAILURE RULES ===\n');
  for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`${String(n).padStart(4)}  ${rule}\n`);
  }
  process.stdout.write(
    '\n=== PER MODEL (adjusted = pass / (pass + model-fails); infra/operator/grader excluded) ===\n',
  );
  const rows = [...byModel.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [model, m] of rows) {
    const judged = m.pass + m.model;
    const raw = m.n > 0 ? Math.round((100 * m.pass) / m.n) : 0;
    const adj = judged > 0 ? Math.round((100 * m.pass) / judged) : 0;
    process.stdout.write(
      `${model.padEnd(28)} n=${String(m.n).padStart(3)} raw=${String(raw).padStart(3)}% adjusted=${String(adj).padStart(3)}% (modelFail=${m.model} infra=${m.infra} operator=${m.operator} grader=${m.grader})\n`,
    );
  }
  if (graderTrials.length > 0) {
    process.stdout.write(`\n=== GRADER-ARTIFACT TRIALS (${graderTrials.length}) ===\n`);
    for (const t of graderTrials) process.stdout.write(`${t}\n`);
  }
  if (dryRun) process.stdout.write('\n(dry-run: no sidecars written)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
