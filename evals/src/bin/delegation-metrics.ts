#!/usr/bin/env -S npx tsx
/**
 * `pnpm --filter @bendyline/gezel-evals exec tsx src/bin/delegation-metrics.ts <dir>`
 *
 * Delegation-focused metrics extractor for the gezels-as-tools-by-role
 * A/B. Walks a runs directory (a single trial dir, a scenario dir, or a
 * whole `matrix-*` / `ab-*` dir), parses every session transcript's
 * assistant `toolCalls`, and reports how the orchestrators ROUTED work —
 * the signal the role-tool feature targets, which scenario pass-rate
 * (throughput/editing-bound) does not isolate.
 *
 * Facts only — no scoring, no policy. The reader compares control vs
 * treatment dirs. Primary contrast: `roleToolCalls` (≈0 in control, >0
 * in treatment) and `correctRoutings` / `wrongRoutings` for the
 * role-typed delegations (whose target role is unambiguous in the tool
 * NAME, unlike the generic dispatchers' free-text argument).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

interface ToolCall {
  name: string;
  success?: boolean;
  argsSummary?: string;
}
interface SessionMessage {
  role: string;
  toolCalls?: ToolCall[];
}
interface SessionFile {
  messages?: SessionMessage[];
}

// Mirrors SCENARIO_EXPECTED_ROLES in score-trial.ts — the roles a
// correct orchestrator would delegate the build to. Underscore + hyphen
// variants both accepted (tool slug is underscore; jobTitle is hyphen).
const SCENARIO_EXPECTED_DELEGATION_ROLES: Record<string, string[]> = {
  tictactoe: ['developer', 'builder'],
  tankcombat: ['developer', 'builder'],
  petshop: ['developer', 'builder', 'designer', 'image_generator', 'image-generator'],
  'tool-routing-image': ['image_generator', 'image-generator'],
};

const GENERIC_DELEGATION_TOOLS = new Set(['message_gezel', 'ask_gezel', 'ask_specialist']);
const SELF_BUILD_TOOLS = new Set([
  'writeFile',
  'appendToFile',
  'replaceInFile',
  'replaceLines',
  'applyPatch',
  'insertAtMarker',
  'run_nodejs_script',
  'run_npx',
  'run_package_script',
]);

function isRoleDelegationTool(name: string): boolean {
  return name.startsWith('delegate_') || name.startsWith('consult_');
}
/** `delegate_image_generator` → `image_generator`; `consult_developer` → `developer`. */
function roleFromToolName(name: string): string {
  return name.replace(/^(?:delegate|consult)_/, '');
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Recursively collect every dir that has a `sessions/` subdir (= a trial dir). */
function findTrialDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('sessions')) {
      try {
        if (statSync(join(dir, 'sessions')).isDirectory()) out.push(dir);
      } catch {}
    }
    for (const e of entries) {
      if (e === 'sessions' || e === 'artifacts' || e === 'workspace') continue;
      let full: string;
      try {
        full = join(dir, e);
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(full);
    }
  };
  walk(root);
  return out;
}

interface TrialMetrics {
  trialDir: string;
  scenario: string;
  roleToolCalls: number;
  genericDelegationCalls: number;
  selfBuildCalls: number;
  /** role-tool target role → count */
  targetRoleHistogram: Record<string, number>;
  correctRoutings: number;
  wrongRoutings: number;
  selfDelegations: number;
}

function scenarioOf(trialDir: string): string {
  // Trial dirs are named `<scenario>-<model>-<ts>-<id>`; scenario is the
  // leading token before the first known scenario boundary. Fall back to
  // the first hyphen segment.
  const name = basename(trialDir);
  for (const s of Object.keys(SCENARIO_EXPECTED_DELEGATION_ROLES)) {
    if (name.startsWith(`${s}-`)) return s;
  }
  return name.split('-')[0] ?? 'unknown';
}

function metricsForTrial(trialDir: string): TrialMetrics {
  const scenario = scenarioOf(trialDir);
  const expected = new Set(SCENARIO_EXPECTED_DELEGATION_ROLES[scenario] ?? []);
  const m: TrialMetrics = {
    trialDir: basename(trialDir),
    scenario,
    roleToolCalls: 0,
    genericDelegationCalls: 0,
    selfBuildCalls: 0,
    targetRoleHistogram: {},
    correctRoutings: 0,
    wrongRoutings: 0,
    selfDelegations: 0,
  };
  let sessionFiles: string[] = [];
  try {
    sessionFiles = readdirSync(join(trialDir, 'sessions'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => join(trialDir, 'sessions', n));
  } catch {
    return m;
  }
  for (const sessPath of sessionFiles) {
    const sess = readJson<SessionFile>(sessPath);
    if (!sess?.messages) continue;
    const callerRole = (basename(sessPath).split('--')[0] ?? '').toLowerCase();
    for (const msg of sess.messages) {
      if (msg.role !== 'assistant') continue;
      for (const c of msg.toolCalls ?? []) {
        if (isRoleDelegationTool(c.name)) {
          m.roleToolCalls++;
          const role = roleFromToolName(c.name);
          m.targetRoleHistogram[role] = (m.targetRoleHistogram[role] ?? 0) + 1;
          if (expected.size > 0) {
            if (expected.has(role)) m.correctRoutings++;
            else m.wrongRoutings++;
          }
          // Self-delegation: caller's session-name prefix is the gezel
          // name, not the role, so this is a heuristic — flag when the
          // delegated role string appears in the caller prefix.
          if (callerRole && role && callerRole.includes(role.split('_')[0] ?? role)) {
            m.selfDelegations++;
          }
        } else if (GENERIC_DELEGATION_TOOLS.has(c.name)) {
          m.genericDelegationCalls++;
        } else if (SELF_BUILD_TOOLS.has(c.name)) {
          m.selfBuildCalls++;
        }
      }
    }
  }
  return m;
}

function main(): void {
  const [, , root] = process.argv;
  if (!root || root === '-h' || root === '--help') {
    console.error('usage: delegation-metrics.ts <runs-dir-or-trial-dir>');
    process.exit(2);
  }
  const trials = findTrialDirs(root).map(metricsForTrial);
  const agg = trials.reduce(
    (a, t) => {
      a.roleToolCalls += t.roleToolCalls;
      a.genericDelegationCalls += t.genericDelegationCalls;
      a.selfBuildCalls += t.selfBuildCalls;
      a.correctRoutings += t.correctRoutings;
      a.wrongRoutings += t.wrongRoutings;
      a.selfDelegations += t.selfDelegations;
      return a;
    },
    {
      roleToolCalls: 0,
      genericDelegationCalls: 0,
      selfBuildCalls: 0,
      correctRoutings: 0,
      wrongRoutings: 0,
      selfDelegations: 0,
    },
  );
  const totalDelegation = agg.roleToolCalls + agg.genericDelegationCalls;
  const totalRouted = agg.correctRoutings + agg.wrongRoutings;
  const summary = {
    root,
    trialCount: trials.length,
    aggregate: {
      ...agg,
      // Of all delegation calls, the share that used a role-typed tool.
      roleToolShareOfDelegation: totalDelegation > 0 ? agg.roleToolCalls / totalDelegation : null,
      // Of all delegation+self-build, the share that delegated (vs DIY).
      delegateVsSelfShare:
        totalDelegation + agg.selfBuildCalls > 0
          ? totalDelegation / (totalDelegation + agg.selfBuildCalls)
          : null,
      // Of role-typed delegations to a scenario with an expected set, the
      // share that hit an expected role.
      correctRoutingShare: totalRouted > 0 ? agg.correctRoutings / totalRouted : null,
    },
    perTrial: trials,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
