/**
 * Chat-model manifest completeness lint.
 *
 * The eval-history analysis found that every multi-day "bad
 * model" debugging saga traced back to a manifest gap, not capability:
 * deepseek-r1 ran with an unbounded thinking budget (0/19 until
 * `thinkingBudget: 512` landed), mistral-medium had no tuning block at
 * all, and the gemma4-26b-q4 QAT swap silently deleted its entire
 * `tuning` block (commit 944685f9) — every gemma4-26b session ran on
 * provider-default sampling for days. These are exactly the blocks the
 * strong models all carry, so their absence is lintable.
 *
 * Severity model:
 *   - ERRORS gate CI via the ratchet test (`chat-model-manifest-lint.test.ts`):
 *     known gaps live in an explicit allowlist there; NEW gaps fail loud.
 *   - WARNINGS are surfaced for authoring guidance but don't gate.
 *
 * Run standalone: `pnpm --filter @bendyline/gezel-catalog exec tsx src/chat-model-manifest-lint.ts`
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gildeDataDir } from './gilde-data.js';

export interface ManifestLintFinding {
  modelId: string;
  rule: string;
  detail: string;
}

export interface ManifestLintReport {
  errors: ManifestLintFinding[];
  warnings: ManifestLintFinding[];
  modelCount: number;
}

interface LooseManifest {
  id?: string;
  license?: string;
  licenseClass?: 'open' | 'commercial-restricted' | 'custom-restricted';
  parameterSize?: string;
  style?: { reasoningFormat?: string };
  tuning?: {
    sampling?: Record<string, unknown>;
    reasoning?: { thinkingBudget?: number; effort?: string; enableThinking?: boolean };
    profiles?: Record<string, unknown>;
  };
  behaviors?: Array<string | { id?: string }>;
  llamaCpp?: { residentBytes?: number };
  mlx?: { residentBytes?: number };
  ds4?: { residentBytes?: number };
}

/** "8B" / "2.3B" / "284B" → numeric billions; null when unparseable. */
function parseParamsB(parameterSize: string | undefined): number | null {
  const m = parameterSize?.match(/^([\d.]+)\s*B$/i);
  return m?.[1] ? Number.parseFloat(m[1]) : null;
}

function behaviorIds(manifest: LooseManifest): Set<string> {
  const out = new Set<string>();
  for (const b of manifest.behaviors ?? []) {
    const id = typeof b === 'string' ? b : b.id;
    if (id) out.add(id);
  }
  return out;
}

/** Param-size ceiling for the "tiny/small model" rescue-behavior warning. */
const SMALL_MODEL_PARAMS_B = 9;
const SMALL_MODEL_RESCUE_BEHAVIORS = ['mcp.relax-required-fields', 'mcp.default-missing-fields'];

/**
 * OpenMDW 1.0 and 1.1 grant unrestricted commercial/non-commercial use,
 * modification, and redistribution of the licensed model materials. Their
 * notice-retention and defensive-litigation clauses are ordinary conditions
 * of a permissive license, not use-based restrictions, so they belong in the
 * same green catalog bucket as Apache/MIT/BSD.
 */
function isPermissiveOpenMdw(license: string | undefined): boolean {
  return /^openmdw[- ]1\.(?:0|1)$/i.test(license?.trim() ?? '');
}

export function lintChatModelManifest(manifest: LooseManifest): ManifestLintReport {
  const modelId = manifest.id ?? '(unknown id)';
  const errors: ManifestLintFinding[] = [];
  const warnings: ManifestLintFinding[] = [];

  if (isPermissiveOpenMdw(manifest.license) && manifest.licenseClass !== 'open') {
    errors.push({
      modelId,
      rule: 'openmdw-not-open',
      detail: `${manifest.license} is permissive and must use licenseClass=open`,
    });
  }

  const tuning = manifest.tuning;
  if (!tuning) {
    errors.push({
      modelId,
      rule: 'missing-tuning',
      detail:
        'no `tuning` block — every session runs on provider-default sampling ' +
        '(the gemma4-26b-q4 QAT-swap regression class)',
    });
  } else {
    if (!tuning.sampling) {
      errors.push({
        modelId,
        rule: 'missing-tuning-sampling',
        detail: '`tuning` block has no `sampling` defaults',
      });
    }
    if (!tuning.profiles || Object.keys(tuning.profiles).length === 0) {
      warnings.push({
        modelId,
        rule: 'missing-profiles',
        detail:
          'no `tuning.profiles` — gezel `tuningProfile`/`suggestedTuningProfile` requests ' +
          'silently fall through to base tuning for this model',
      });
    }
  }

  // A thinking-format model with no bound on reasoning output repeats the
  // deepseek-r1 saga: unlimited budget → reason-forever → every turn
  // aborted by the post-reasoning watchdog. gpt-oss-style `effort` enums
  // and an explicit `enableThinking: false` both count as bounds.
  const reasoningFormat = manifest.style?.reasoningFormat;
  const isThinkingFormat = reasoningFormat === 'think' || reasoningFormat === 'channel';
  if (isThinkingFormat && tuning) {
    const r = tuning.reasoning;
    const bounded =
      typeof r?.thinkingBudget === 'number' ||
      typeof r?.effort === 'string' ||
      r?.enableThinking === false;
    if (!bounded) {
      errors.push({
        modelId,
        rule: 'unbounded-reasoning',
        detail: `style.reasoningFormat=${reasoningFormat} but tuning.reasoning has no thinkingBudget / effort / enableThinking:false — unbounded thinking stalls turns (deepseek-r1 was 0/19 until thinkingBudget:512 landed)`,
      });
    }
  }

  if (
    typeof manifest.llamaCpp?.residentBytes !== 'number' &&
    typeof manifest.mlx?.residentBytes !== 'number' &&
    typeof manifest.ds4?.residentBytes !== 'number'
  ) {
    errors.push({
      modelId,
      rule: 'missing-resident-bytes',
      detail:
        'no `llamaCpp.residentBytes`, `mlx.residentBytes`, or `ds4.residentBytes` — the capacity broker cannot ' +
        'reserve for this model and either over-admits (OOM) or mis-denies',
    });
  }

  const paramsB = parseParamsB(manifest.parameterSize);
  if (paramsB !== null && paramsB <= SMALL_MODEL_PARAMS_B) {
    const ids = behaviorIds(manifest);
    const missing = SMALL_MODEL_RESCUE_BEHAVIORS.filter((b) => !ids.has(b));
    if (missing.length > 0) {
      warnings.push({
        modelId,
        rule: 'missing-small-model-rescue-behaviors',
        detail: `${manifest.parameterSize} model without ${missing.join(' + ')} — small models drop required tool-call fields routinely; these behaviors are why qwen3.5-2b out-executes mistral-7b on the same harness`,
      });
    }
  }

  return { errors, warnings, modelCount: 1 };
}

/** Default data dir: the installed (or link:ed) @bendyline/gilde package. */
export function defaultChatModelsDataDir(): string {
  return join(gildeDataDir(), 'chat-models');
}

export function lintAllChatModelManifests(dataDir?: string): ManifestLintReport {
  const root = dataDir ?? defaultChatModelsDataDir();
  const errors: ManifestLintFinding[] = [];
  const warnings: ManifestLintFinding[] = [];
  let modelCount = 0;
  for (const prefix of readdirSync(root, { withFileTypes: true })) {
    if (!prefix.isDirectory()) continue;
    for (const entry of readdirSync(join(root, prefix.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(root, prefix.name, entry.name, 'manifest.json');
      let manifest: LooseManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LooseManifest;
      } catch {
        errors.push({
          modelId: entry.name,
          rule: 'unreadable-manifest',
          detail: `cannot read/parse ${manifestPath}`,
        });
        continue;
      }
      modelCount += 1;
      const report = lintChatModelManifest(manifest);
      errors.push(...report.errors);
      warnings.push(...report.warnings);
    }
  }
  return { errors, warnings, modelCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = lintAllChatModelManifests(process.argv[2]);
  process.stdout.write(`linted ${report.modelCount} chat-model manifests\n\n`);
  for (const f of report.errors) {
    process.stdout.write(`ERROR  ${f.modelId.padEnd(28)} ${f.rule}: ${f.detail}\n`);
  }
  for (const f of report.warnings) {
    process.stdout.write(`WARN   ${f.modelId.padEnd(28)} ${f.rule}: ${f.detail}\n`);
  }
  process.stdout.write(
    `\n${report.errors.length} error(s), ${report.warnings.length} warning(s)\n`,
  );
  process.exit(report.errors.length > 0 ? 1 : 0);
}
