/**
 * Exhaustive bundled prompt/tool contract matrix.
 *
 * Crosses every standard (non-fixed-function) gezel role template with every
 * local chat-model/backend pair, the model's resolved behavior profile, the
 * production tier/tool cap, and representative session shapes. The rendered
 * prompt is linted against the exact post-filter roster advertised that turn.
 *
 * Run:
 *   pnpm test:extended
 *   pnpm test:extended -- --json
 *
 * Focused alias:
 *   pnpm lint:prompts
 *   pnpm lint:prompts -- --json
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  type ChatSession,
  type ProjectDetail,
  type ProjectFileEntry,
  type ProviderName,
  type ResolvedSecurityPolicy,
  type Task,
  resolveExecutionDensity,
  resolveSecurityPolicy,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { loadBuiltinToolContractsForLint } from '@bendyline/gezel-mcp/lint-contracts';
import { resolveProfile } from '../model-profile/registry.js';
import { applyBehaviorEnvOverrides, profileHasBehavior } from '../model-profile/runtime.js';
import type { ResolvedModelProfile, TurnCtx } from '../model-profile/types.js';
import { classifyModelTier } from './local-model-tier.js';
import { type PromptTaskContext, buildInstructions } from './manager.js';
import {
  type PromptToolContractFinding,
  type PromptToolContractReport,
  formatPromptToolContractFinding,
  lintPromptToolContract,
} from './prompt-tool-contract.js';
import {
  extractToolCallStringCorpus,
  lintPromptToolSchemaContract,
} from './prompt-tool-schema-contract.js';
import { isPureDelegationRole, roleToolAllowlist } from './role-tool-filter.js';
import {
  availableBuiltinToolsForAllowlist,
  resolveSessionToolSurface,
} from './session-tool-surface.js';

type LocalMatrixProvider = Extract<ProviderName, 'ollama' | 'llama-cpp' | 'mlx' | 'ds4'>;

export interface PromptContractMatrixCase {
  roleId: string;
  role: string;
  modelId: string;
  provider: LocalMatrixProvider;
  tier: string;
  behaviors: string[];
  scenario: string;
  toolStrategy: string;
  securityLevel: string;
  toolCount: number;
  toolCapTrimmed: boolean;
  droppedToolCount: number;
  tools: string[];
  promptHash: string;
  toolSurfaceHash: string;
  errors: PromptToolContractFinding[];
  warnings: PromptToolContractFinding[];
}

export interface PromptContractMatrixReport {
  roleCount: number;
  modelCount: number;
  modelBackendCount: number;
  scenarioCount: number;
  toolStrategyCount: number;
  caseCount: number;
  distinctPromptCount: number;
  distinctToolSurfaceCount: number;
  toolSchemaCount: number;
  mcpSourceStringCount: number;
  cases: PromptContractMatrixCase[];
  errors: Array<PromptToolContractFinding & { matrix: string }>;
  warnings: Array<PromptToolContractFinding & { matrix: string }>;
  tierCases: Record<string, number>;
  tierCapTrimCases: Record<string, number>;
}

interface MatrixScenario {
  id: string;
  latestUserMessage: string;
  workspaceFiles?: ProjectFileEntry[];
  task?: PromptTaskContext;
  assignedTasks?: Task[];
  consultationMode?: boolean;
  expectedDeliverable?: { kind: 'file' | 'chat'; filePath?: string };
  securityPolicy: ResolvedSecurityPolicy;
  /**
   * Per-project workspace writability for the scenario (see
   * `projectWorkspaceWritable`). `false` exercises the edits-off prompt
   * contract (write tools stripped + posture note); omitted → writable.
   */
  workspaceWritable?: boolean;
  executorOnly?: boolean;
  delegationOnly?: boolean;
  existingSubstantialFile?: boolean;
}

interface MatrixToolStrategy {
  id: 'default' | 'coordinator-tool-diet';
  coordinatorToolDiet: boolean;
}

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT: ProjectDetail = {
  id: 'prompt-contract-project',
  name: 'Prompt contract fixture',
  description: 'A deterministic project used to lint rendered prompts.',
  mode: 'crew',
  createdAt: NOW,
  updatedAt: NOW,
  packages: [],
  about: 'Build and review project files. Keep the implementation small and verifiable.',
  missionObjectives: '- Produce the named deliverable.\n- Verify it before reporting completion.',
};

function taskFixture(args: {
  role: string;
  procedure: string;
  deliverable?: string;
  onExitScript?: string;
}): PromptTaskContext {
  const step = {
    id: 'build',
    name: 'Build the deliverable',
    description: args.deliverable
      ? `Create ${args.deliverable} and leave a concise progress note.`
      : 'Coordinate the assigned work and leave a concise progress note.',
    prompt: args.procedure,
    suggestedRole: args.role,
    ...(args.deliverable
      ? {
          advanceWhen: {
            file: args.deliverable,
            minBytes: 100,
            sniff: args.deliverable.endsWith('.html')
              ? ('html-complete' as const)
              : ('nonempty' as const),
            goto: 'verify',
          },
        }
      : {}),
    next: 'verify',
    ...(args.onExitScript ? { onExit: { name: args.onExitScript } } : {}),
    createdAt: NOW,
    attemptCount: 1,
  };
  const task: Task = {
    projectId: PROJECT.id,
    num: 1,
    ref: `${PROJECT.id}/1`,
    title: 'Build a simple space-war game',
    description:
      'Create a playable single-file space-war game with movement, shooting, enemies, score, and restart behavior.',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: `fixture-${args.role.toLowerCase()}` },
    craftbook: {
      id: 'prompt-contract-build',
      name: 'Prompt contract build',
      steps: [
        step,
        {
          id: 'verify',
          name: 'Verify',
          terminal: true,
          createdAt: NOW,
          attemptCount: 0,
        },
      ],
      entryStepId: 'build',
      createdAt: NOW,
      updatedAt: NOW,
    },
    activeStepId: 'build',
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { kind: 'user' },
  };
  return { task, step, notes: '- Preserve the exact requested path.' };
}

function scenariosForRole(
  role: string,
  canWriteWorkspace: boolean,
  delegationRole: boolean,
): MatrixScenario[] {
  const normal = resolveSecurityPolicy({});
  const locked = resolveSecurityPolicy({
    securityPolicy: securityPolicyForLevel('super-lockdown'),
  });
  const common: MatrixScenario[] = [
    {
      id: 'generic-project-chat',
      latestUserMessage: 'What should we do next?',
      workspaceFiles: [{ name: 'README.md', path: 'README.md', isDirectory: false }],
      securityPolicy: normal,
    },
    {
      id: 'review-existing-file',
      latestUserMessage: 'Review index.html and report the concrete defects you find.',
      workspaceFiles: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
      securityPolicy: normal,
      existingSubstantialFile: true,
    },
    {
      // Super-lockdown no longer strips workspace writes globally — the
      // per-project contract does. Keep the locked policy (script/git/
      // service strips) AND a non-writable project so the edits-off
      // prompt contract stays exercised.
      id: 'file-request-writes-off',
      latestUserMessage: 'Create a new index.html with a playable space-war game.',
      workspaceFiles: [],
      securityPolicy: locked,
      workspaceWritable: false,
    },
    {
      id: 'assigned-task-overview',
      latestUserMessage: 'What should I continue working on?',
      workspaceFiles: [{ name: 'README.md', path: 'README.md', isDirectory: false }],
      assignedTasks: [
        taskFixture({
          role,
          procedure: 'Complete the assigned work and leave clear evidence for the task owner.',
        }).task,
      ],
      securityPolicy: normal,
    },
  ];
  if (role.toLowerCase().includes('meester')) {
    common.push(
      {
        id: 'meester-crew-build-prelude',
        latestUserMessage: 'Build a space-war game with a custom logo, code, tests, and docs.',
        workspaceFiles: [],
        securityPolicy: normal,
      },
      {
        id: 'meester-craftbook-library-prelude',
        latestUserMessage:
          'Find and use an existing craftbook from the recipe library for reviewing a pull request.',
        workspaceFiles: [],
        securityPolicy: normal,
      },
      {
        id: 'meester-craftbook-author-prelude',
        latestUserMessage:
          'Create a reusable weekly procedure for reviewing project quality and invoking the right crew.',
        workspaceFiles: [],
        securityPolicy: normal,
      },
      {
        id: 'meester-data-transform-prelude',
        latestUserMessage: 'Normalize and deduplicate this CSV export without dropping records.',
        workspaceFiles: [{ name: 'customers.csv', path: 'customers.csv', isDirectory: false }],
        securityPolicy: normal,
      },
    );
  }
  if (canWriteWorkspace) {
    common.push(
      {
        id: 'fresh-single-file-build',
        latestUserMessage: 'Build a new playable space-war game at `index.html`.',
        workspaceFiles: [],
        securityPolicy: normal,
        executorOnly: true,
      },
      {
        id: 'task-scoped-build',
        latestUserMessage:
          'Continue the active step. Record the checklist, then build the game at `index.html`.',
        workspaceFiles: [],
        task: taskFixture({
          role,
          deliverable: 'index.html',
          procedure:
            'Your first assistant action must be `write_task_note({ ref, text })` with a short acceptance checklist. Then create `index.html` with `writeFile({ path, content })` and validate it.',
          onExitScript: 'verify-space-war',
        }),
        securityPolicy: normal,
        executorOnly: true,
      },
      {
        id: 'file-consultation',
        latestUserMessage: 'Write the requested analysis to `space-war-review.md`.',
        workspaceFiles: [{ name: 'index.html', path: 'index.html', isDirectory: false }],
        consultationMode: true,
        expectedDeliverable: { kind: 'file', filePath: 'space-war-review.md' },
        securityPolicy: normal,
        executorOnly: true,
      },
    );
  } else if (delegationRole) {
    common.push({
      id: 'delegation-task',
      latestUserMessage: 'Keep the project moving and hand the build to the right specialist.',
      workspaceFiles: [],
      task: taskFixture({
        role,
        procedure:
          'Your first assistant action must be `write_task_note({ ref, text })` with the acceptance checklist. Then use `message_gezel` to hand the implementation to the assigned builder.',
      }),
      securityPolicy: normal,
      delegationOnly: true,
    });
  }
  return common;
}

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

function toolStrategiesFor(tier: string, role: string): MatrixToolStrategy[] {
  const strategies: MatrixToolStrategy[] = [{ id: 'default', coordinatorToolDiet: false }];
  const normalizedRole = role.toLowerCase();
  const isCoordinator =
    normalizedRole.includes('meester') ||
    normalizedRole.includes('voorman') ||
    normalizedRole.includes('foreman');
  if ((tier === 'medium' || tier === 'large') && isCoordinator) {
    strategies.push({ id: 'coordinator-tool-diet', coordinatorToolDiet: true });
  }
  return strategies;
}

function matrixKey(row: Omit<PromptContractMatrixCase, 'errors' | 'warnings'>): string {
  return `${row.roleId} × ${row.modelId}/${row.provider} × ${row.scenario} × ${row.toolStrategy}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function resolveMatrixUserPrelude(args: {
  profile: ResolvedModelProfile;
  providerName: LocalMatrixProvider;
  modelId: string;
  sessionId: string;
  userText: string;
  isMeester: boolean;
}): string | null {
  const ctx: TurnCtx = {
    catalogId: args.profile.catalogId,
    tier: args.profile.tier,
    family: args.profile.style.family,
    modelId: args.modelId,
    providerName: args.providerName,
    sessionId: args.sessionId,
    isMeester: args.isMeester,
    userText: args.userText,
    drained: [],
    assistantContent: '',
    continuationCount: 0,
  };
  for (const entry of args.profile.behaviors) {
    const hook = entry.behavior.userPromptPrelude;
    if (!hook) continue;
    const text = hook(ctx, entry.config);
    if (text) return text;
  }
  return null;
}

export async function buildPromptContractMatrix(): Promise<PromptContractMatrixReport> {
  const catalog = new CatalogService();
  const toolContracts = await loadBuiltinToolContractsForLint();
  const toolNamesWithSchemas = toolContracts.map((tool) => tool.name);
  const staticSchemaErrors: Array<PromptToolContractFinding & { matrix: string }> = [];
  for (const tool of toolContracts) {
    const descriptionContract = lintPromptToolSchemaContract({
      prompt: tool.description,
      toolContracts,
    });
    staticSchemaErrors.push(
      ...descriptionContract.errors.map((finding) => ({
        ...finding,
        matrix: `tool-description:${tool.name}`,
      })),
    );
  }
  const mcpServerSource = await readFile(
    new URL('../../../mcp/src/server.ts', import.meta.url),
    'utf8',
  );
  const mcpSourceCorpus = extractToolCallStringCorpus({
    sourceText: mcpServerSource,
    toolNames: toolNamesWithSchemas,
  });
  for (const entry of mcpSourceCorpus) {
    const sourceContract = lintPromptToolSchemaContract({
      prompt: entry.text,
      toolContracts,
    });
    staticSchemaErrors.push(
      ...sourceContract.errors.map((finding) => ({
        ...finding,
        matrix: `mcp-source:server.ts:${entry.line}`,
      })),
    );
  }
  const roleItems = (await catalog.list('gezel-template')).filter(
    (item) => item.manifest.kind === 'gezel-template' && !item.manifest.frontmatter?.fixedFunction,
  );
  const modelItems = (await catalog.list('chat-model')).filter(
    (item) => item.manifest.kind === 'chat-model' && item.manifest.supportsTools,
  );
  const cases: PromptContractMatrixCase[] = [];
  const tierCases: Record<string, number> = {};
  const tierCapTrimCases: Record<string, number> = {};
  const scenarioIds = new Set<string>();
  const toolStrategyIds = new Set<string>();
  const schemaContractCache = new Map<string, PromptToolContractReport>();
  let modelBackendCount = 0;

  for (const modelItem of modelItems) {
    if (modelItem.manifest.kind !== 'chat-model') continue;
    const manifest = modelItem.manifest;
    const providers = providersForModel(manifest);
    modelBackendCount += providers.length;
    for (const provider of providers) {
      const tier = classifyModelTier({
        providerName: provider,
        modelId: manifest.id,
        parameterSize: manifest.parameterSize,
      });
      const profile = applyBehaviorEnvOverrides(
        resolveProfile({ manifest, tier, providerName: provider }),
      );
      const rolesAsTools = profileHasBehavior(profile, 'tools.gezels-as-roles');
      const trimExecutorContext = profileHasBehavior(profile, 'prompt.executor-context-trim');
      const retrievalFirst = profileHasBehavior(profile, 'prompt.retrieval-first');

      for (const roleItem of roleItems) {
        if (roleItem.manifest.kind !== 'gezel-template') continue;
        const roleManifest = roleItem.manifest;
        const detail = await catalog.get('gezel-template', roleManifest.id, roleItem.sourceId);
        const about = detail?.about ?? '';
        const canWriteWorkspace = roleToolAllowlist(roleManifest.role).has('writeFile');
        const delegationRole = isPureDelegationRole(roleManifest.role);
        for (const scenario of scenariosForRole(
          roleManifest.role,
          canWriteWorkspace,
          delegationRole,
        )) {
          scenarioIds.add(scenario.id);
          for (const toolStrategy of toolStrategiesFor(tier, roleManifest.role)) {
            toolStrategyIds.add(toolStrategy.id);
            let capTrim: { before: number; after: number; dropped: string[] } | undefined;
            const session: ChatSession = {
              version: 1,
              id: `matrix-${roleManifest.id}-${manifest.id}-${provider}-${scenario.id}-${toolStrategy.id}`,
              gezelId: `fixture-${roleManifest.id}`,
              projectId: PROJECT.id,
              providerName: provider,
              model: manifest.id,
              title: 'Prompt contract fixture',
              createdAt: NOW,
              lastActivityAt: NOW,
              messages: [{ role: 'user', content: scenario.latestUserMessage, at: NOW }],
              providerState: {},
              ...(scenario.task
                ? { taskRef: scenario.task.task.ref, stepId: scenario.task.step?.id }
                : {}),
              ...(scenario.consultationMode ? { consultationMode: true } : {}),
              ...(scenario.expectedDeliverable
                ? { expectedDeliverable: scenario.expectedDeliverable }
                : {}),
            };
            const surface = await resolveSessionToolSurface({
              surface: 'prompt',
              session,
              role: roleManifest.role,
              mode: 'always',
              provider,
              modelId: manifest.id,
              parameterSize: manifest.parameterSize,
              toolsetsGroupOverride: [],
              projectMode: PROJECT.mode,
              ...(scenario.consultationMode ? { consultationMode: true } : {}),
              ...(rolesAsTools ? { rolesAsTools: true } : {}),
              githubLinked: false,
              isGitRepo: false,
              securityPolicy: scenario.securityPolicy,
              ...(scenario.workspaceWritable !== undefined
                ? { workspaceWritable: scenario.workspaceWritable }
                : {}),
              tier,
              coordinatorToolDiet: toolStrategy.coordinatorToolDiet,
              latestUserMessage: scenario.latestUserMessage,
              onCapTrim: (event) => {
                capTrim = event;
              },
              ...(scenario.task?.step ? { activeStep: scenario.task.step } : {}),
              ...(scenario.existingSubstantialFile
                ? { existingSubstantialFileForImmediate: async () => true }
                : {}),
            });
            const availableTools = availableBuiltinToolsForAllowlist(surface.allowlist);
            const instructions = buildInstructions({
              name: roleManifest.name,
              roleBasedName: roleManifest.id,
              about,
              role: roleManifest.role,
              providerName: provider,
              executionDensity: resolveExecutionDensity(undefined, provider, tier),
              gezelId: session.gezelId,
              project: PROJECT,
              workspaceFiles: scenario.workspaceFiles,
              documentFiles: [],
              task: scenario.task,
              assignedTasks: scenario.assignedTasks,
              localModelTier: tier,
              modelId: manifest.id,
              profile,
              installedToolsetIds: new Set(),
              availableTools,
              thirdPartyToolsetIds: [],
              ...(scenario.consultationMode ? { consultationMode: true } : {}),
              ...(scenario.expectedDeliverable
                ? { expectedDeliverable: scenario.expectedDeliverable }
                : {}),
              ...(trimExecutorContext ? { trimExecutorContext: true } : {}),
              ...(retrievalFirst ? { retrievalFirstHint: true } : {}),
              ...(scenario.workspaceWritable !== undefined
                ? { workspaceWritable: scenario.workspaceWritable }
                : {}),
              layeredPrefixCache: provider === 'llama-cpp',
            });
            const userPrelude = resolveMatrixUserPrelude({
              profile,
              providerName: provider,
              modelId: manifest.id,
              sessionId: session.id,
              userText: scenario.latestUserMessage,
              isMeester: roleManifest.id === 'meester',
            });
            const renderedPrompt = [instructions.full, instructions.volatileContext, userPrelude]
              .filter((part): part is string => Boolean(part))
              .join('\n\n');
            const toolNames = availableTools.map((tool) => tool.name);
            const promptHash = shortHash(renderedPrompt);
            const contract = lintPromptToolContract({
              prompt: renderedPrompt,
              availableTools: toolNames,
            });
            let schemaContract = schemaContractCache.get(promptHash);
            if (!schemaContract) {
              schemaContract = lintPromptToolSchemaContract({
                prompt: renderedPrompt,
                toolContracts,
              });
              schemaContractCache.set(promptHash, schemaContract);
            }
            // Standard role templates are standing identity, not a dynamic tool
            // manual. Any imperative missing-tool reference inside about.md is
            // therefore build-blocking (the runtime cannot gate it per turn),
            // even though the same broad lexical shape is merely advisory when
            // it comes from a model cookbook or contextual example.
            const aboutContract = lintPromptToolContract({
              prompt: about,
              availableTools: toolNames,
            });
            const promotedAboutFindings = aboutContract.warnings.map((finding) => ({
              ...finding,
              severity: 'error' as const,
            }));
            const rowErrors = [
              ...contract.errors,
              ...schemaContract.errors,
              ...aboutContract.errors,
              ...promotedAboutFindings,
            ];
            const rowWarnings = contract.warnings;
            const rowBase = {
              roleId: roleManifest.id,
              role: roleManifest.role,
              modelId: manifest.id,
              provider,
              tier,
              behaviors: profile.behaviors.map((entry) => entry.id),
              scenario: scenario.id,
              toolStrategy: toolStrategy.id,
              securityLevel: scenario.securityPolicy.level,
              toolCount: toolNames.length,
              toolCapTrimmed: capTrim !== undefined,
              droppedToolCount: capTrim?.dropped.length ?? 0,
              tools: toolNames,
              promptHash,
              toolSurfaceHash: shortHash([...toolNames].sort().join('\n')),
            };
            cases.push({ ...rowBase, errors: rowErrors, warnings: rowWarnings });
            tierCases[tier] = (tierCases[tier] ?? 0) + 1;
            if (capTrim) tierCapTrimCases[tier] = (tierCapTrimCases[tier] ?? 0) + 1;
          }
        }
      }
    }
  }

  const errors = [
    ...staticSchemaErrors,
    ...cases.flatMap((row) =>
      row.errors.map((finding) => ({ ...finding, matrix: matrixKey(row) })),
    ),
  ];
  const warnings = cases.flatMap((row) =>
    row.warnings.map((finding) => ({ ...finding, matrix: matrixKey(row) })),
  );
  const requiredTierCoverage = ['tiny', 'small', 'medium'] as const;
  const missingTiers = requiredTierCoverage.filter((tier) => !tierCases[tier]);
  if (missingTiers.length > 0) {
    throw new Error(
      `Prompt contract matrix lost required model-tier coverage: ${missingTiers.join(', ')}. Keep at least one bundled model/backend path for every capped/conditioned tier; unset GEZEL_FORCE_MODEL_TIER when running the static matrix.`,
    );
  }
  const missingCapExercise = requiredTierCoverage.filter((tier) => !tierCapTrimCases[tier]);
  if (missingCapExercise.length > 0) {
    throw new Error(
      `Prompt contract matrix did not exercise an active tool-count cap for: ${missingCapExercise.join(', ')}. Keep the default tiny/small caps and the medium coordinator-diet strategy represented in this matrix.`,
    );
  }
  return {
    roleCount: roleItems.length,
    modelCount: modelItems.length,
    modelBackendCount,
    scenarioCount: scenarioIds.size,
    toolStrategyCount: toolStrategyIds.size,
    caseCount: cases.length,
    distinctPromptCount: new Set(cases.map((row) => row.promptHash)).size,
    distinctToolSurfaceCount: new Set(cases.map((row) => row.toolSurfaceHash)).size,
    toolSchemaCount: toolContracts.length,
    mcpSourceStringCount: mcpSourceCorpus.length,
    cases,
    errors,
    warnings,
    tierCases,
    tierCapTrimCases,
  };
}

function printReport(report: PromptContractMatrixReport): void {
  process.stdout.write(
    `Prompt contract matrix: ${report.caseCount} rendered cases\n` +
      `  ${report.roleCount} standard roles × ${report.modelCount} models / ${report.modelBackendCount} model-backends × ${report.scenarioCount} scenario shapes\n` +
      `  ${report.toolStrategyCount} tool strategies (default + env-gated coordinator diet where applicable)\n` +
      `  ${report.distinctPromptCount} distinct rendered prompts; ${report.distinctToolSurfaceCount} distinct resolved tool rosters\n` +
      `  ${report.toolSchemaCount} live MCP input schemas; ${report.mcpSourceStringCount} MCP source strings with tool-call examples\n` +
      `  tier cases: ${Object.entries(report.tierCases)
        .map(([tier, count]) => `${tier}=${count}`)
        .join(', ')}\n` +
      `  cap-trim cases: ${Object.entries(report.tierCapTrimCases)
        .map(([tier, count]) => `${tier}=${count}`)
        .join(', ')}\n\n`,
  );
  const displayLimit = 100;
  const aggregate = (
    findings: Array<PromptToolContractFinding & { matrix: string }>,
  ): Array<PromptToolContractFinding & { matrix: string; occurrences: number }> => {
    const bySignature = new Map<
      string,
      PromptToolContractFinding & { matrix: string; occurrences: number }
    >();
    for (const finding of findings) {
      const signature = `${finding.rule}:${finding.tool ?? ''}:${finding.excerpt}`;
      const existing = bySignature.get(signature);
      if (existing) existing.occurrences += 1;
      else bySignature.set(signature, { ...finding, occurrences: 1 });
    }
    return [...bySignature.values()].sort((a, b) => b.occurrences - a.occurrences);
  };
  const uniqueErrors = aggregate(report.errors);
  const uniqueWarnings = aggregate(report.warnings);
  for (const finding of uniqueErrors.slice(0, displayLimit)) {
    process.stdout.write(
      `ERROR  ${finding.matrix}${finding.occurrences > 1 ? ` (+${finding.occurrences - 1} equivalent cases)` : ''}\n` +
        `       ${formatPromptToolContractFinding(finding)}\n`,
    );
  }
  for (const finding of uniqueWarnings.slice(0, displayLimit)) {
    process.stdout.write(
      `WARN   ${finding.matrix}${finding.occurrences > 1 ? ` (+${finding.occurrences - 1} equivalent cases)` : ''}\n` +
        `       ${formatPromptToolContractFinding(finding)}\n`,
    );
  }
  const hiddenErrors = Math.max(0, uniqueErrors.length - displayLimit);
  const hiddenWarnings = Math.max(0, uniqueWarnings.length - displayLimit);
  if (hiddenErrors || hiddenWarnings) {
    process.stdout.write(
      `\n(${hiddenErrors} additional errors and ${hiddenWarnings} additional warnings omitted; rerun with --json for the complete matrix.)\n`,
    );
  }
  process.stdout.write(
    `\n${report.errors.length} error occurrence(s) / ${uniqueErrors.length} unique; ` +
      `${report.warnings.length} warning occurrence(s) / ${uniqueWarnings.length} unique; ` +
      `${report.caseCount} cases\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildPromptContractMatrix();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
  process.exit(report.errors.length > 0 ? 1 : 0);
}
