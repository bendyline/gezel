/**
 * Append-only repairs for the remaining concrete craftbook graph findings:
 * missing rejection routes, unsafe reviewer defaults, and an excessive gate
 * retry budget. Each release inherits its existing local eval sidecar.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CraftbookDocSchema,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { requireGildeCheckout } from './gilde-checkout.js';

const RELEASED_AT = '2026-09-26T22:30:00Z';

type Repair = {
  id: string;
  sourceVersion: string;
  targetVersion: string;
  apply: (doc: Record<string, unknown>) => void;
};

function step(doc: Record<string, unknown>, id: string): Record<string, unknown> {
  const steps = doc.steps;
  if (!Array.isArray(steps)) throw new Error(`${String(doc.id)}: steps are missing`);
  const found = steps.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' && candidate !== null && candidate.id === id,
  );
  if (!found) throw new Error(`${String(doc.id)}: step ${id} is missing`);
  return found;
}

function addRejectRoute(doc: Record<string, unknown>, stepId: string): void {
  const target = step(doc, stepId);
  const gate = target.gate;
  if (typeof gate !== 'object' || gate === null || Array.isArray(gate)) {
    throw new Error(`${String(doc.id)}: ${stepId} gate is missing`);
  }
  const typedGate = gate as Record<string, unknown>;
  if (typedGate.onReject !== undefined) {
    throw new Error(`${String(doc.id)}: ${stepId} already has onReject`);
  }
  typedGate.onReject = stepId;
}

function makeReviewerDefaultSafe(doc: Record<string, unknown>): void {
  const evaluate = step(doc, 'evaluate');
  if (evaluate.next !== 'finish') {
    throw new Error(`${String(doc.id)}: evaluate no longer defaults to finish`);
  }
  if (!String(evaluate.prompt ?? '').includes('next: "finish"')) {
    throw new Error(`${String(doc.id)}: evaluate lacks an explicit PASS-to-finish instruction`);
  }
  // The prompt owns the exceptional content/conversion repair branches. Keep
  // the declarative default aligned with the ordinary PASS branch so a
  // reviewer that omits an explicit override still advances safely.
}

const REPAIRS: Repair[] = [
  {
    id: 'draft-social-post',
    sourceVersion: '1.0.3',
    targetVersion: '1.0.4',
    apply: (doc) => {
      addRejectRoute(doc, 'brief');
      addRejectRoute(doc, 'finalize');
    },
  },
  {
    id: 'reception-report',
    sourceVersion: '1.0.3',
    targetVersion: '1.0.4',
    apply: (doc) => addRejectRoute(doc, 'reconcile'),
  },
  {
    id: 'social-digest',
    sourceVersion: '1.0.4',
    targetVersion: '1.0.5',
    apply: (doc) => addRejectRoute(doc, 'scan'),
  },
  {
    id: 'narrated-slideshow',
    sourceVersion: '1.1.4',
    targetVersion: '1.1.5',
    apply: makeReviewerDefaultSafe,
  },
  {
    id: 'powerpoint-deck',
    sourceVersion: '1.7.13',
    targetVersion: '1.7.14',
    apply: makeReviewerDefaultSafe,
  },
  {
    id: 'report-pdf',
    sourceVersion: '1.1.4',
    targetVersion: '1.1.5',
    apply: makeReviewerDefaultSafe,
  },
  {
    id: 'research-to-document',
    sourceVersion: '1.2.4',
    targetVersion: '1.2.5',
    apply: makeReviewerDefaultSafe,
  },
  {
    id: 'invoice-run',
    sourceVersion: '1.1.6',
    targetVersion: '1.1.7',
    apply: (doc) => {
      const collect = step(doc, 'collect');
      const gate = collect.gate;
      if (typeof gate !== 'object' || gate === null || Array.isArray(gate)) {
        throw new Error('invoice-run: collect gate is missing');
      }
      const typedGate = gate as Record<string, unknown>;
      if (typedGate.maxAttempts !== 8) {
        throw new Error(
          `invoice-run: expected maxAttempts 8, found ${String(typedGate.maxAttempts)}`,
        );
      }
      typedGate.maxAttempts = 4;
    },
  },
];

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { dataDir } = requireGildeCheckout();
  const plans: Array<{ repair: Repair; versionDir: string; craftbook: string; test: string }> = [];

  for (const repair of REPAIRS) {
    const bookDir = join('craftbook-templates', repair.id.slice(0, 2), repair.id);
    const sourceDir = join(dataDir, bookDir, 'versions', repair.sourceVersion);
    const versionDir = join(dataDir, bookDir, 'versions', repair.targetVersion);
    if (await pathExists(versionDir)) {
      throw new Error(`${repair.id}: refusing to overwrite ${versionDir}`);
    }
    const raw = JSON.parse(await readFile(join(sourceDir, 'craftbook.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (raw.version !== repair.sourceVersion) {
      throw new Error(`${repair.id}: unexpected source version ${String(raw.version)}`);
    }
    raw.version = repair.targetVersion;
    raw.releasedAt = RELEASED_AT;
    repair.apply(raw);
    const doc = CraftbookDocSchema.parse(raw);
    const runtime = craftbookFromDoc(doc, { now: RELEASED_AT });
    if (!runtime.ok) {
      throw new Error(
        `${repair.id}: repaired document failed validation:\n${formatCraftbookDocErrors(runtime.errors)}`,
      );
    }
    plans.push({
      repair,
      versionDir,
      craftbook: serializeCraftbookDoc(doc, 'json'),
      test: await readFile(join(sourceDir, 'test.json'), 'utf8'),
    });
  }

  for (const plan of plans) {
    console.log(
      `${dryRun ? 'would write' : 'writing'} ${plan.repair.id}@${plan.repair.targetVersion}`,
    );
    if (dryRun) continue;
    await mkdir(plan.versionDir, { recursive: false });
    await writeFile(join(plan.versionDir, 'craftbook.json'), plan.craftbook);
    await writeFile(join(plan.versionDir, 'test.json'), plan.test);
  }
}

await main();
