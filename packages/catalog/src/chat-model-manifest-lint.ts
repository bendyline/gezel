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
  llamaCpp?: { residentBytes?: number; huggingfaceRepo?: string; quantization?: string };
  mlx?: { residentBytes?: number; huggingfaceRepo?: string; quantization?: string };
  ds4?: { residentBytes?: number };
}

/**
 * Bit width implied by a quantization label, or null when unrecognized.
 *
 * Deliberately label-driven: the two engines name the same width
 * differently (`Q8_0` vs `8bit`, `UD-Q4_K_XL` vs `4bit`), and the label is
 * what a reviewer reads in the manifest.
 */
function quantBits(quantization: string | undefined): number | null {
  const q = quantization?.toLowerCase();
  if (!q) return null;
  if (/(^|[^0-9])(q8|8bit|mxfp8)/.test(q)) return 8;
  if (/(^|[^0-9])(q6|6bit)/.test(q)) return 6;
  if (/(^|[^0-9])(q5|5bit)/.test(q)) return 5;
  if (/(^|[^0-9])(q4|4bit|fp4|oq4)/.test(q)) return 4;
  if (/(^|[^0-9])(q3|3bit)/.test(q)) return 3;
  if (/(^|[^0-9])(q2|2bit)/.test(q)) return 2;
  if (/bf16|f16|fp16/.test(q)) return 16;
  return null;
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

/**
 * MLX's standard affine quantization widths. Anything else (nvfp4, MXFP4,
 * oQ4e, …) is a vendor/experimental format that may or may not have
 * first-class Metal kernels — worth a human look, not an automatic failure.
 */
const MLX_NATIVE_QUANT_LABELS = /^(3|4|5|6|8)bit$|^bf16$|^f16$/i;

/**
 * Widths at or below which QAT-vs-non-QAT is a material quality gap worth
 * gating on. Above this the quantization error QAT corrects is small enough
 * that a mismatch isn't worth failing CI over.
 */
const QAT_MATTERS_MAX_BITS = 5;

/**
 * Tier-default behavior lists, mirrored from
 * `packages/service/src/model-profile/defaults.ts`. Duplicated rather than
 * imported because the catalog package must not depend on the service; the
 * `tier-defaults-in-sync` test pins them together.
 */
const TIER_DEFAULT_BEHAVIOR_IDS: Record<'tiny' | 'small' | 'medium' | 'large', string[]> = {
  tiny: [
    'prompt.tool-cookbook-full',
    'mcp.relax-required-fields',
    'mcp.default-missing-fields',
    'mcp.compact-tool-schemas',
    'fabrication.detect-past-tense-no-tools',
    'turn.continuation-budget',
    'prompt.retrieval-first',
  ],
  small: [
    'prompt.tool-cookbook-condensed',
    'mcp.compact-tool-schemas',
    'fabrication.detect-past-tense-no-tools',
    'prompt.retrieval-first',
  ],
  medium: [
    'mcp.compact-tool-schemas',
    'fabrication.detect-past-tense-no-tools',
    'prompt.retrieval-first',
    'prompt.workspace-gestalt',
  ],
  large: ['fabrication.detect-past-tense-no-tools', 'prompt.workspace-gestalt'],
};

/** Local tier from a `parameterSize` label — mirrors `classifyLocalModelTier`. */
export function tierForParams(
  parameterSize: string | undefined,
): keyof typeof TIER_DEFAULT_BEHAVIOR_IDS {
  const m = parameterSize?.match(/^E?([\d.]+)\s*B$/i);
  if (!m?.[1]) return 'tiny';
  // Gemma "E<n>B" effective-parameter labels behave like a 2n model.
  const b = Number.parseFloat(m[1]) * (/^e/i.test(parameterSize ?? '') ? 2 : 1);
  if (b < 5) return 'tiny';
  if (b < 12) return 'small';
  if (b < 45) return 'medium';
  return 'large';
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

  // Cross-engine quant parity. One model id must mean one quality level: a
  // user picking `gemma4-e4b-q8` should not silently get 8-bit weights on
  // llama.cpp and 4-bit on MLX. Wild-caught 2026-07-31 — the whole gemma
  // MLX deficit in that sweep traced here, not to the engine:
  //   e4b-q8/e2b-q8  Q8_0 vs 4bit  → neither could complete a tool
  //                                  round-trip on MLX (llama-cpp: 7/11)
  //   31b-q4         QAT vs non-QAT → 11/11 on llama-cpp, 4/11 on MLX
  //   26b-q4         QAT vs QAT-nvfp4 → 11/11 on llama-cpp, 5/11 on MLX
  // Bit-width and QAT parity are unambiguous defects (errors). Format
  // oddity is a warning: some models ship a vendor format natively
  // (gpt-oss is genuinely MXFP4 upstream), so it needs a human read.
  const lBits = quantBits(manifest.llamaCpp?.quantization);
  const xBits = quantBits(manifest.mlx?.quantization);
  if (lBits !== null && xBits !== null && lBits !== xBits) {
    errors.push({
      modelId,
      rule: 'engine-quant-bits-mismatch',
      detail: `llamaCpp is ${manifest.llamaCpp?.quantization} (${lBits}-bit) but mlx is ${manifest.mlx?.quantization} (${xBits}-bit) — one model id must mean one quality level across engines; pick matching widths or split into separate ids`,
    });
  }
  // QAT parity, but only where QAT actually buys something. Quantization
  // error scales inversely with bit width, so QAT's compensation is
  // load-bearing at 4-bit and largely redundant by 8-bit — flagging an
  // 8-bit pair would be noise. Gate on the shared width.
  const lQat = /qat/i.test(manifest.llamaCpp?.huggingfaceRepo ?? '');
  const xQat = /qat/i.test(manifest.mlx?.huggingfaceRepo ?? '');
  const sharedBits = lBits !== null && lBits === xBits ? lBits : null;
  if (
    manifest.llamaCpp?.huggingfaceRepo &&
    manifest.mlx?.huggingfaceRepo &&
    lQat !== xQat &&
    sharedBits !== null &&
    sharedBits <= QAT_MATTERS_MAX_BITS
  ) {
    errors.push({
      modelId,
      rule: 'engine-quant-qat-mismatch',
      detail: `at ${sharedBits}-bit, ${lQat ? 'llamaCpp' : 'mlx'} uses quantization-aware-trained weights but ${lQat ? 'mlx' : 'llamaCpp'} does not — at this width QAT is a large quality difference, so this hands one engine's users worse weights under the same model id`,
    });
  }
  if (xBits !== null && !MLX_NATIVE_QUANT_LABELS.test(manifest.mlx?.quantization ?? '')) {
    warnings.push({
      modelId,
      rule: 'mlx-nonstandard-quant-format',
      detail: `mlx quantization "${manifest.mlx?.quantization}" is not one of MLX's standard affine widths — confirm Metal has first-class kernels for it (nvfp4 targets NVIDIA Blackwell; MXFP4 is native for some upstreams and legitimate there)`,
    });
  }

  // Tier defaults a manifest silently forfeits. Declaring ANY `behaviors`
  // REPLACES the tier list wholesale (model-profile/registry.ts) — only the
  // universal defaults are appended — so a curated manifest that omits an
  // entry opts out of it without saying so. Measured 2026-07-31 on the same
  // 71-tool surface: `mcp.compact-tool-schemas` present = 98,394 schema chars,
  // absent = 145,748, i.e. ~12K tokens per turn on every turn.
  //
  // A warning, not an error: full ownership is the documented contract, and a
  // model may legitimately want out of, say, `prompt.retrieval-first`. But the
  // omission should be a decision someone made, not one they inherited.
  const declared = behaviorIds(manifest);
  if (declared.size > 0) {
    const tier = tierForParams(manifest.parameterSize);
    const dropped = TIER_DEFAULT_BEHAVIOR_IDS[tier].filter((id) => !declared.has(id));
    if (dropped.length > 0) {
      warnings.push({
        modelId,
        rule: 'drops-tier-default-behaviors',
        detail: `declaring \`behaviors\` replaces the ${tier}-tier defaults entirely, so this manifest opts out of: ${dropped.join(', ')} — re-declare any that were not deliberate${dropped.includes('mcp.compact-tool-schemas') ? ' (compact-tool-schemas alone is ~12K tokens/turn)' : ''}`,
      });
    }
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
