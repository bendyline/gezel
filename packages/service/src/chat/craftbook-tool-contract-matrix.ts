/**
 * Exhaustive bundled craftbook step/tool contract matrix.
 *
 * Unlike the role-oriented prompt matrix, this walks the actual latest
 * bundled craftbook steps (including spawn children) through the production
 * role, security, step-kit, authored-policy, model-tier cap, and gate-repair
 * filters. A step procedure is executable configuration: every tool it tells
 * the model to use must survive, every structural output must retain a writer,
 * and generated policies should subtract tool groups the step does not need.
 */

import { pathToFileURL } from 'node:url';
import {
  type ChatSession,
  type CraftbookStep,
  type CraftbookStepOutputMedium,
  type CraftbookTemplateManifest,
  type ModelTier,
  type ProviderName,
  effectiveCapabilityFloor,
  resolveSecurityPolicy,
  securityPolicyForLevel,
  tierAtLeast,
} from '@bendyline/gezel';
import { CatalogService, applyDefaultCraftbookStepPolicies } from '@bendyline/gezel-catalog';
import { loadBuiltinToolContractsForLint } from '@bendyline/gezel-mcp/lint-contracts';
import { resolveProfile } from '../model-profile/registry.js';
import { applyBehaviorEnvOverrides, profileHasBehavior } from '../model-profile/runtime.js';
import { classifyModelTier } from './local-model-tier.js';
import {
  lintPromptToolContract,
  promptConditionallyReferencedTools,
} from './prompt-tool-contract.js';
import { lintPromptToolSchemaContract } from './prompt-tool-schema-contract.js';
import {
  availableBuiltinToolsForAllowlist,
  resolveSessionToolSurface,
  taskStepContextualBuiltinTools,
} from './session-tool-surface.js';

type LocalMatrixProvider = Extract<ProviderName, 'ollama' | 'llama-cpp' | 'mlx' | 'ds4'>;
type StepPhase = 'initial' | 'gate-repair' | 'policy';

interface CraftbookStepEntry {
  craftbookId: string;
  craftbookName: string;
  version: string;
  stepId: string;
  step: CraftbookStep;
  spawn: boolean;
  manifest: CraftbookTemplateManifest;
}

export interface CraftbookToolContractFinding {
  severity: 'error' | 'warning';
  rule:
    | 'prompt-tool-contract'
    | 'prompt-tool-schema'
    | 'surface-missing-output-writer'
    | 'surface-missing-conditional-tool'
    | 'surface-missing-step-completion'
    | 'surface-unexpected-output-writer'
    | 'policy-missing-output-declaration'
    | 'policy-missing-builtin-denial'
    | 'policy-missing-toolset-denial';
  craftbookId: string;
  craftbookName: string;
  version: string;
  stepId: string;
  spawn: boolean;
  phase: StepPhase;
  role: string;
  modelId?: string;
  provider?: LocalMatrixProvider;
  tier?: string;
  tool?: string;
  detail: string;
  excerpt?: string;
  occurrences: number;
  examples: string[];
}

export interface CraftbookToolContractMatrixReport {
  craftbookCount: number;
  stepCount: number;
  spawnStepCount: number;
  modelCount: number;
  modelBackendCount: number;
  caseCount: number;
  skippedBelowFloorCount: number;
  gateRepairCaseCount: number;
  capTrimCaseCount: number;
  tierCases: Record<string, number>;
  errorCraftbookCount: number;
  errorStepCount: number;
  errorsByRule: Record<string, number>;
  warningsByRule: Record<string, number>;
  errors: CraftbookToolContractFinding[];
  warnings: CraftbookToolContractFinding[];
}

interface FindingInput extends Omit<CraftbookToolContractFinding, 'occurrences' | 'examples'> {
  example?: string;
}

const WORKSPACE_OUTPUT_TOOLS = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'insert_at_marker',
  'derive_file',
]);

function providersForModel(manifest: {
  ollama?: unknown;
  llamaCpp?: unknown;
  mlx?: unknown;
  ds4?: unknown;
}): LocalMatrixProvider[] {
  const out: LocalMatrixProvider[] = [];
  if (manifest.ollama) out.push('ollama');
  if (manifest.llamaCpp) out.push('llama-cpp');
  if (manifest.mlx) out.push('mlx');
  if (manifest.ds4) out.push('ds4');
  return out;
}

function toolStrategiesFor(
  tier: string,
  role: string,
): Array<{
  id: 'default' | 'coordinator-tool-diet';
  coordinatorToolDiet: boolean;
}> {
  const strategies: Array<{
    id: 'default' | 'coordinator-tool-diet';
    coordinatorToolDiet: boolean;
  }> = [{ id: 'default', coordinatorToolDiet: false }];
  const normalizedRole = role.toLowerCase();
  const coordinator =
    normalizedRole.includes('meester') ||
    normalizedRole.includes('voorman') ||
    normalizedRole.includes('foreman');
  if ((tier === 'medium' || tier === 'large') && coordinator) {
    strategies.push({ id: 'coordinator-tool-diet', coordinatorToolDiet: true });
  }
  return strategies;
}

function outputMediaFromPolicy(
  policy: CraftbookStep['toolPolicy'],
): Set<Exclude<CraftbookStepOutputMedium, 'none'>> {
  const media = new Set<Exclude<CraftbookStepOutputMedium, 'none'>>();
  if (policy?.outputMedium && policy.outputMedium !== 'none') media.add(policy.outputMedium);
  for (const medium of policy?.additionalOutputMedia ?? []) media.add(medium);
  return media;
}

/** Re-run generated defaults without carrying old generated denials forward. */
function expectedPolicyForStep(
  entry: CraftbookStepEntry,
): NonNullable<CraftbookStep['toolPolicy']> {
  const { toolPolicy, ...stepWithoutPolicy } = entry.step;
  const retainedOutputPolicy = toolPolicy
    ? {
        ...(toolPolicy.outputMedium !== undefined ? { outputMedium: toolPolicy.outputMedium } : {}),
        ...(toolPolicy.additionalOutputMedia !== undefined
          ? { additionalOutputMedia: toolPolicy.additionalOutputMedia }
          : {}),
      }
    : undefined;
  const normalized = applyDefaultCraftbookStepPolicies({
    name: entry.craftbookName,
    steps: [
      {
        ...stepWithoutPolicy,
        ...(retainedOutputPolicy ? { toolPolicy: retainedOutputPolicy } : {}),
      },
    ],
    ...(entry.manifest.toolsets ? { toolsets: entry.manifest.toolsets } : {}),
  });
  return normalized.steps[0]!.toolPolicy!;
}

function outputWriterAvailable(
  medium: Exclude<CraftbookStepOutputMedium, 'none'>,
  tools: ReadonlySet<string>,
): boolean {
  if (medium === 'artifact') return tools.has('write_artifact');
  if (medium === 'task-note') return tools.has('write_task_note');
  return [...WORKSPACE_OUTPUT_TOOLS].some((tool) => tools.has(tool));
}

function outputWriterNames(
  medium: Exclude<CraftbookStepOutputMedium, 'none'>,
  tools: ReadonlySet<string>,
): string[] {
  if (medium === 'artifact') return tools.has('write_artifact') ? ['write_artifact'] : [];
  if (medium === 'task-note') return tools.has('write_task_note') ? ['write_task_note'] : [];
  return [...WORKSPACE_OUTPUT_TOOLS].filter((tool) => tools.has(tool));
}

function stepEntries(manifests: CraftbookTemplateManifest[]): CraftbookStepEntry[] {
  return manifests.flatMap((manifest) => [
    ...manifest.steps.map((step) => ({
      craftbookId: manifest.id,
      craftbookName: manifest.name,
      version: manifest.version,
      stepId: step.id,
      step,
      spawn: false,
      manifest,
    })),
    ...(manifest.spawn?.steps ?? []).map((step) => ({
      craftbookId: manifest.id,
      craftbookName: manifest.name,
      version: manifest.version,
      stepId: step.id,
      step,
      spawn: true,
      manifest,
    })),
  ]);
}

function findingKey(finding: FindingInput): string {
  return [
    finding.severity,
    finding.rule,
    finding.craftbookId,
    finding.version,
    finding.spawn ? 'spawn' : 'main',
    finding.stepId,
    finding.phase,
    finding.tool ?? '',
    finding.detail,
    finding.excerpt ?? '',
  ].join('\u0000');
}

function addFinding(
  findings: Map<string, CraftbookToolContractFinding>,
  input: FindingInput,
): void {
  const key = findingKey(input);
  const existing = findings.get(key);
  if (existing) {
    existing.occurrences += 1;
    if (
      input.example &&
      existing.examples.length < 3 &&
      !existing.examples.includes(input.example)
    ) {
      existing.examples.push(input.example);
    }
    return;
  }
  findings.set(key, {
    ...input,
    occurrences: 1,
    examples: input.example ? [input.example] : [],
  });
}

function addPolicyFindings(
  findings: Map<string, CraftbookToolContractFinding>,
  entry: CraftbookStepEntry,
  expectedPolicy: NonNullable<CraftbookStep['toolPolicy']>,
): void {
  const role = entry.step.suggestedRole ?? 'Generalist';
  const actualPolicy = entry.step.toolPolicy;
  const expectedMedia = outputMediaFromPolicy(expectedPolicy);
  const declaredMedia = outputMediaFromPolicy(actualPolicy);
  for (const medium of expectedMedia) {
    if (declaredMedia.has(medium)) continue;
    addFinding(findings, {
      severity: 'error',
      rule: 'policy-missing-output-declaration',
      craftbookId: entry.craftbookId,
      craftbookName: entry.craftbookName,
      version: entry.version,
      stepId: entry.stepId,
      spawn: entry.spawn,
      phase: 'policy',
      role,
      detail: `Published policy must declare ${medium} output, but the step does not.`,
    });
  }
  const actualBuiltinDenials = new Set(actualPolicy?.disallowBuiltinToolsets ?? []);
  for (const group of expectedPolicy.disallowBuiltinToolsets ?? []) {
    if (actualBuiltinDenials.has(group)) continue;
    addFinding(findings, {
      severity: 'warning',
      rule: 'policy-missing-builtin-denial',
      craftbookId: entry.craftbookId,
      craftbookName: entry.craftbookName,
      version: entry.version,
      stepId: entry.stepId,
      spawn: entry.spawn,
      phase: 'policy',
      role,
      detail: `Generated policy can disallow built-in toolset ${group}, but the published step leaves it undeclared.`,
    });
  }
  const actualToolsetDenials = new Set(actualPolicy?.disallowToolsets ?? []);
  for (const toolset of expectedPolicy.disallowToolsets ?? []) {
    if (actualToolsetDenials.has(toolset)) continue;
    addFinding(findings, {
      severity: 'warning',
      rule: 'policy-missing-toolset-denial',
      craftbookId: entry.craftbookId,
      craftbookName: entry.craftbookName,
      version: entry.version,
      stepId: entry.stepId,
      spawn: entry.spawn,
      phase: 'policy',
      role,
      detail: `Generated policy can disallow declared toolset ${toolset}, but the published step leaves it undeclared.`,
    });
  }
}

export async function buildCraftbookToolContractMatrix(): Promise<CraftbookToolContractMatrixReport> {
  const catalog = new CatalogService();
  const craftbookItems = (await catalog.list('craftbook-template')).filter(
    (item) => item.manifest.kind === 'craftbook-template',
  );
  // Catalog list entries are deliberately compact and can omit newer
  // step-level fields. Resolve each latest detail so the matrix audits the
  // same full manifest TaskManager embeds, including toolPolicy and spawn.
  const manifests = (
    await Promise.all(
      craftbookItems.map(async (item) => {
        const detail = await catalog.get(
          'craftbook-template',
          item.manifest.id,
          item.sourceId,
          item.manifest.version,
        );
        return detail?.manifest.kind === 'craftbook-template' ? detail.manifest : null;
      }),
    )
  ).filter((manifest): manifest is CraftbookTemplateManifest => manifest !== null);
  const entries = stepEntries(manifests);
  const modelItems = (await catalog.list('chat-model')).filter(
    (item) => item.manifest.kind === 'chat-model' && item.manifest.supportsTools,
  );
  const toolContracts = await loadBuiltinToolContractsForLint();
  const registeredToolNames = new Set(toolContracts.map((tool) => tool.name));
  const findings = new Map<string, CraftbookToolContractFinding>();
  const expectedPolicies = new Map<CraftbookStepEntry, NonNullable<CraftbookStep['toolPolicy']>>();

  for (const entry of entries) {
    const expectedPolicy = expectedPolicyForStep(entry);
    expectedPolicies.set(entry, expectedPolicy);
    addPolicyFindings(findings, entry, expectedPolicy);
    const schemaContract = lintPromptToolSchemaContract({
      prompt: entry.step.prompt ?? '',
      toolContracts,
    });
    for (const schemaFinding of schemaContract.errors) {
      addFinding(findings, {
        severity: 'error',
        rule: 'prompt-tool-schema',
        craftbookId: entry.craftbookId,
        craftbookName: entry.craftbookName,
        version: entry.version,
        stepId: entry.stepId,
        spawn: entry.spawn,
        phase: 'policy',
        role: entry.step.suggestedRole ?? 'Generalist',
        ...(schemaFinding.tool ? { tool: schemaFinding.tool } : {}),
        detail: schemaFinding.detail,
        excerpt: schemaFinding.excerpt,
      });
    }
  }

  let modelBackendCount = 0;
  let caseCount = 0;
  let skippedBelowFloorCount = 0;
  let gateRepairCaseCount = 0;
  let capTrimCaseCount = 0;
  const tierCases: Record<string, number> = {};

  for (const modelItem of modelItems) {
    if (modelItem.manifest.kind !== 'chat-model') continue;
    const model = modelItem.manifest;
    const providers = providersForModel(model);
    modelBackendCount += providers.length;
    for (const provider of providers) {
      const tier = classifyModelTier({
        providerName: provider,
        modelId: model.id,
        parameterSize: model.parameterSize,
      });
      const profile = applyBehaviorEnvOverrides(
        resolveProfile({ manifest: model, tier, providerName: provider }),
      );
      const rolesAsTools = profileHasBehavior(profile, 'tools.gezels-as-roles');

      for (const entry of entries) {
        const role = entry.step.suggestedRole ?? 'Generalist';
        const floor = effectiveCapabilityFloor(entry.step, entry.manifest);
        if (floor && !tierAtLeast(tier as ModelTier, floor)) {
          skippedBelowFloorCount += 1;
          continue;
        }
        const githubLinked =
          entry.manifest.requirements?.some((requirement) => requirement.kind === 'github') ??
          false;
        // Exercise the minimum context in which the catalog says the book is
        // runnable. Do not silently give every procedure a git checkout: a
        // book with no repository requirement must either work in an ordinary
        // project or make its git-only path explicitly conditional.
        const isGitRepo =
          githubLinked ||
          (entry.manifest.requirements?.some(
            (requirement) => requirement.kind === 'non-main-branch',
          ) ??
            false);
        const phases: Array<{ phase: Exclude<StepPhase, 'policy'>; step: CraftbookStep }> = [
          { phase: 'initial', step: entry.step },
          ...(entry.step.gate
            ? [
                {
                  phase: 'gate-repair' as const,
                  step: {
                    ...entry.step,
                    gateAttempts: 1,
                    lastGateReject: { message: 'Repair the rejected step.' },
                  } as CraftbookStep,
                },
              ]
            : []),
        ];

        for (const strategy of toolStrategiesFor(tier, role)) {
          for (const phase of phases) {
            let trimmed = false;
            const session: ChatSession = {
              version: 1,
              id: `craftbook-contract-${entry.craftbookId}-${entry.stepId}-${provider}-${strategy.id}-${phase.phase}`,
              gezelId: `fixture-${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              projectId: 'craftbook-contract-project',
              providerName: provider,
              model: model.id,
              title: `${entry.craftbookName}: ${entry.step.name}`,
              createdAt: '2026-01-01T00:00:00.000Z',
              lastActivityAt: '2026-01-01T00:00:00.000Z',
              messages: [
                {
                  role: 'user',
                  content:
                    phase.phase === 'gate-repair'
                      ? 'The gate rejected this step. Repair the deliverable and try again.'
                      : 'Continue the active craftbook step.',
                  at: '2026-01-01T00:00:00.000Z',
                },
              ],
              providerState: {},
              taskRef: `craftbook-contract-project/${entry.craftbookId}`,
              stepId: entry.stepId,
            };
            const conditionallyReferencedTools = promptConditionallyReferencedTools(
              phase.step.prompt ?? '',
            );
            const contextualBuiltinTools = [
              ...new Set([
                ...taskStepContextualBuiltinTools(session, phase.step),
                ...conditionallyReferencedTools,
              ]),
            ];
            const surface = await resolveSessionToolSurface({
              surface: 'prompt',
              session,
              role,
              mode: 'always',
              provider,
              modelId: model.id,
              parameterSize: model.parameterSize,
              toolsetsGroupOverride: [],
              projectMode: 'crew',
              ...(rolesAsTools ? { rolesAsTools: true } : {}),
              githubLinked,
              isGitRepo,
              securityPolicy:
                conditionallyReferencedTools.size > 0
                  ? resolveSecurityPolicy({
                      securityPolicy: securityPolicyForLevel('free'),
                    })
                  : resolveSecurityPolicy({}),
              workspaceWritable: true,
              contextualBuiltinTools,
              tier,
              coordinatorToolDiet: strategy.coordinatorToolDiet,
              latestUserMessage: session.messages[0]?.content,
              activeStep: phase.step,
              onCapTrim: () => {
                trimmed = true;
              },
            });
            caseCount += 1;
            if (phase.phase === 'gate-repair') gateRepairCaseCount += 1;
            if (trimmed) capTrimCaseCount += 1;
            tierCases[tier] = (tierCases[tier] ?? 0) + 1;

            const tools = new Set(
              availableBuiltinToolsForAllowlist(
                surface.allowlist,
                contextualBuiltinTools,
                registeredToolNames,
              ).map((tool) => tool.name),
            );
            const example = `${model.id}/${provider}/${tier}/${strategy.id}`;
            for (const tool of conditionallyReferencedTools) {
              if (tools.has(tool)) continue;
              addFinding(findings, {
                severity: 'error',
                rule: 'surface-missing-conditional-tool',
                craftbookId: entry.craftbookId,
                craftbookName: entry.craftbookName,
                version: entry.version,
                stepId: entry.stepId,
                spawn: entry.spawn,
                phase: phase.phase,
                role,
                modelId: model.id,
                provider,
                tier,
                tool,
                detail: `Prompt branches on ${tool} being registered, but the enabled-context surface cannot expose it.`,
                example,
              });
            }
            const promptContract = lintPromptToolContract({
              prompt: entry.step.prompt ?? '',
              availableTools: tools,
              partialRoster: true,
            });
            // A craftbook step is executable procedure, so even a soft
            // recommendation for a missing built-in is build-blocking.
            for (const promptFinding of [...promptContract.errors, ...promptContract.warnings]) {
              addFinding(findings, {
                severity: 'error',
                rule: 'prompt-tool-contract',
                craftbookId: entry.craftbookId,
                craftbookName: entry.craftbookName,
                version: entry.version,
                stepId: entry.stepId,
                spawn: entry.spawn,
                phase: phase.phase,
                role,
                modelId: model.id,
                provider,
                tier,
                ...(promptFinding.tool ? { tool: promptFinding.tool } : {}),
                detail: promptFinding.detail,
                excerpt: promptFinding.excerpt,
                example,
              });
            }

            const expectedMedia = outputMediaFromPolicy(expectedPolicies.get(entry));
            for (const medium of expectedMedia) {
              if (outputWriterAvailable(medium, tools)) continue;
              addFinding(findings, {
                severity: 'error',
                rule: 'surface-missing-output-writer',
                craftbookId: entry.craftbookId,
                craftbookName: entry.craftbookName,
                version: entry.version,
                stepId: entry.stepId,
                spawn: entry.spawn,
                phase: phase.phase,
                role,
                modelId: model.id,
                provider,
                tier,
                detail: `Step requires ${medium} output, but its resolved surface has no matching writer.`,
                example,
              });
            }
            for (const medium of ['workspace', 'artifact', 'task-note'] as const) {
              if (expectedMedia.has(medium)) continue;
              const unexpected = outputWriterNames(medium, tools);
              if (unexpected.length === 0) continue;
              addFinding(findings, {
                severity: 'error',
                rule: 'surface-unexpected-output-writer',
                craftbookId: entry.craftbookId,
                craftbookName: entry.craftbookName,
                version: entry.version,
                stepId: entry.stepId,
                spawn: entry.spawn,
                phase: phase.phase,
                role,
                modelId: model.id,
                provider,
                tier,
                detail: `Step does not declare ${medium} output, but its resolved surface still exposes ${unexpected.join(', ')}.`,
                example,
              });
            }
            if (!tools.has('advance_task_step')) {
              addFinding(findings, {
                severity: 'error',
                rule: 'surface-missing-step-completion',
                craftbookId: entry.craftbookId,
                craftbookName: entry.craftbookName,
                version: entry.version,
                stepId: entry.stepId,
                spawn: entry.spawn,
                phase: phase.phase,
                role,
                modelId: model.id,
                provider,
                tier,
                tool: 'advance_task_step',
                detail: 'Active step surface cannot advance the task.',
                example,
              });
            }
          }
        }
      }
    }
  }

  const allFindings = [...findings.values()].sort(
    (a, b) =>
      a.craftbookId.localeCompare(b.craftbookId) ||
      a.stepId.localeCompare(b.stepId) ||
      a.rule.localeCompare(b.rule),
  );
  const errors = allFindings.filter((finding) => finding.severity === 'error');
  const warnings = allFindings.filter((finding) => finding.severity === 'warning');
  const countByRule = (items: CraftbookToolContractFinding[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.rule] = (counts[item.rule] ?? 0) + 1;
    return counts;
  };
  return {
    craftbookCount: manifests.length,
    stepCount: entries.length,
    spawnStepCount: entries.filter((entry) => entry.spawn).length,
    modelCount: modelItems.length,
    modelBackendCount,
    caseCount,
    skippedBelowFloorCount,
    gateRepairCaseCount,
    capTrimCaseCount,
    tierCases,
    errorCraftbookCount: new Set(errors.map((finding) => finding.craftbookId)).size,
    errorStepCount: new Set(
      errors.map(
        (finding) => `${finding.craftbookId}/${finding.spawn ? 'spawn:' : ''}${finding.stepId}`,
      ),
    ).size,
    errorsByRule: countByRule(errors),
    warningsByRule: countByRule(warnings),
    errors,
    warnings,
  };
}

export function printCraftbookToolContractMatrixReport(
  report: CraftbookToolContractMatrixReport,
): void {
  process.stdout.write(
    `Craftbook tool contract matrix: ${report.caseCount} resolved step cases\n` +
      `  ${report.craftbookCount} latest craftbooks; ${report.stepCount} steps (${report.spawnStepCount} spawn children)\n` +
      `  ${report.modelCount} tool-capable models / ${report.modelBackendCount} model-backends\n` +
      `  gate-repair cases=${report.gateRepairCaseCount}; below-floor skips=${report.skippedBelowFloorCount}; cap trims=${report.capTrimCaseCount}\n` +
      `  tier cases: ${Object.entries(report.tierCases)
        .map(([tier, count]) => `${tier}=${count}`)
        .join(', ')}\n` +
      `  errors: ${report.errorCraftbookCount} craftbooks / ${report.errorStepCount} steps; ${
        Object.entries(report.errorsByRule)
          .map(([rule, count]) => `${rule}=${count}`)
          .join(', ') || 'none'
      }\n` +
      `  warnings: ${
        Object.entries(report.warningsByRule)
          .map(([rule, count]) => `${rule}=${count}`)
          .join(', ') || 'none'
      }\n\n`,
  );
  const displayLimit = 200;
  for (const finding of [...report.errors, ...report.warnings].slice(0, displayLimit)) {
    const location = `${finding.craftbookId}@${finding.version}/${finding.spawn ? 'spawn:' : ''}${finding.stepId}`;
    const examples = finding.examples.length > 0 ? ` [${finding.examples.join(', ')}]` : '';
    process.stdout.write(
      `${finding.severity === 'error' ? 'ERROR' : 'WARN '}  ${location} ${finding.phase}\n` +
        `       ${finding.rule}${finding.tool ? ` tool=${finding.tool}` : ''}: ${finding.detail}${finding.occurrences > 1 ? ` (${finding.occurrences} cases)` : ''}${examples}\n` +
        `${finding.excerpt ? `       “${finding.excerpt}”\n` : ''}`,
    );
  }
  const hidden = Math.max(0, report.errors.length + report.warnings.length - displayLimit);
  if (hidden > 0) process.stdout.write(`\n(${hidden} additional findings omitted; use --json.)\n`);
  process.stdout.write(
    `\n${report.errors.length} unique error(s); ${report.warnings.length} policy warning(s); ${report.caseCount} cases\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildCraftbookToolContractMatrix();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printCraftbookToolContractMatrixReport(report);
  }
  process.exit(report.errors.length > 0 ? 1 : 0);
}
