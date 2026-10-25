import {
  GENERALIST_TEMPLATE_ID,
  type GezelConfig,
  type ProviderName,
  type Task,
  type TaskCraftbookStep,
  createLogger,
  deriveTaskRequestRef,
  effectiveGeneralistModeSetting,
  parseTaskRef,
  resolveTaskExecutionMode,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { resolveDefaultProviderName } from '../providers/default-provider.js';
import { ensureCommandApprovalQuestions } from '../workspace/scripts.js';
import { loadTaskOutputs } from './completion-wrapup.js';
import { reviewTaskFigures } from './figure-review.js';
import { type TaskManager, stepOwnerGezelId } from './manager.js';
import { ownerStepQuestion } from './owner-step.js';
import { isOwnerStep } from './step-runtime.js';

const log = createLogger('service');

interface TaskCreationDependencies {
  home: string;
  store: Store;
  catalog: CatalogService;
  chat: ChatManager;
  chatEvents: ChatEventBus;
  tasks: TaskManager;
}

export async function wireTaskCreation({
  home,
  store,
  catalog,
  chat,
  chatEvents,
  tasks,
}: TaskCreationDependencies) {
  // Role auto-assignment: a craftbook step's `suggestedRole` resolves
  // to a concrete gezel id (roster match → gilde template → bespoke)
  // at step-activation time. Without this a /review craftbook
  // assigned to a Developer-template gezel keeps that Developer; with
  // it, the entry step pulls the Reviewer onto the project and hands
  // off cleanly. Errors are swallowed inside TaskManager — a
  // misconfigured wiring falls back to the task-level assignee.
  const { ensureGezel } = await import('../gezels/ensure.js');
  // Gezels the resolver hired (not reused) wait here until their first step
  // starts, when the owner's thread introduces them.
  const freshHires = new Set<string>();
  const introduceFreshHire = (task: Task, step: TaskCraftbookStep | undefined): void => {
    const gezelId = step ? stepOwnerGezelId(task, step) : undefined;
    if (!step || !gezelId || !freshHires.delete(gezelId)) return;
    void chat
      .postCrewIntroduction(task, gezelId, step, 'joined')
      .catch((err) =>
        log.warn(`[service] crew introduction failed for ${task.ref}: ${String(err)}`),
      );
  };
  // A task launched from a chat introduces its crew there as it starts:
  // whoever takes the entry step, and the lead when that is someone else.
  // A typed project's lead and a kickoff's voorman are not resolver hires,
  // so before this they arrived without a word.
  const introduceAtKickoff = (task: Task, step: TaskCraftbookStep | undefined): void => {
    const gezelId = step ? stepOwnerGezelId(task, step) : undefined;
    if (!step || !gezelId) return;
    const fresh = freshHires.delete(gezelId);
    if (!fresh && !task.launchSessionId) return;
    void chat
      .postCrewIntroduction(task, gezelId, step, 'kickoff')
      .catch((err) =>
        log.warn(`[service] crew introduction failed for ${task.ref}: ${String(err)}`),
      );
  };
  // Named so the craftbook command launcher (below) can reuse the exact
  // same role→gezel resolution the step-activation path uses.
  const roleResolverClosure = async (
    role: string,
    projectId: string,
  ): Promise<{ gezelId: string } | null> => {
    try {
      const res = await ensureGezel({
        opts: { jobTitle: role },
        store,
        catalog,
        chat,
        // Role resolution runs inside advance_task_step's HTTP/MCP request.
        // Never synchronously invoke the local model that is waiting for this
        // tool result; curated Gilde templates still win above this fallback.
        bespokeMode: 'static',
      });
      // Pull the resolved gezel onto the project roster so the step
      // assignee is actually a project member — without this the
      // handoff fires but the project sidebar doesn't show the
      // gezel, and `list_project_gezels` misses them.
      await store.addGezelToProject(projectId, res.gezelId, { source: 'task' }).catch(() => {
        /* roster add is best-effort */
      });
      if (res.action !== 'reused') freshHires.add(res.gezelId);
      return { gezelId: res.gezelId };
    } catch (err) {
      log.warn(
        `[tasks] ensureGezel failed for role="${role}":`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };
  tasks.setRoleResolver(roleResolverClosure);

  tasks.setRequestRefResolver((task) =>
    deriveTaskRequestRef(task, {
      task: async (ref) => {
        const parsed = parseTaskRef(ref);
        return parsed ? store.readTask(parsed.projectId, parsed.num) : null;
      },
      session: (id) => store.findSessionById(id),
    }),
  );

  // Execution mode (generalist v2): decided once per task from the install
  // setting and the provider that will actually run it, then stamped on
  // the task. An auto-assigned generalist task gets the Generalist gezel
  // (one per install, reused by template id) pulled onto the project;
  // a task whose caller pinned an owner keeps that owner. Errors fall back
  // to stepwise inside TaskManager, the behavior every task had before.
  tasks.setExecutionModeResolver(async ({ projectId, assigneeGezelId, nightShift, requested }) => {
    const config = await store.readConfig();
    const setting = effectiveGeneralistModeSetting(config);
    let providerName: ProviderName | undefined;
    let tier: string | undefined;
    let mode: 'generalist' | 'stepwise';
    if (requested === 'generalist' || requested === 'stepwise') {
      mode = requested;
    } else {
      providerName = assigneeGezelId
        ? await chat.providerForGezel(assigneeGezelId, { nightShift: Boolean(nightShift) })
        : resolveDefaultProviderName(config);
      tier = await chat.classifyExecutionTier(providerName, assigneeGezelId);
      mode = resolveTaskExecutionMode(setting, providerName, tier);
    }
    const base = {
      ...(setting ? { setting } : {}),
      ...(providerName ? { providerName } : {}),
      ...(tier ? { tier } : {}),
    };
    if (mode !== 'generalist' || assigneeGezelId) return { mode, ...base };
    const generalist = await ensureGezel({
      opts: { jobTitle: 'Generalist', templateId: GENERALIST_TEMPLATE_ID },
      store,
      catalog,
      chat,
      bespokeMode: 'static',
    });
    await store.addGezelToProject(projectId, generalist.gezelId, { source: 'task' }).catch(() => {
      /* roster add is best-effort */
    });
    // The Generalist may carry its own provider pin (a user parked it on a
    // local model). Under `auto` that pin decides, not the install default:
    // a single-session run on a model the rule says is not ready for it is
    // exactly what `auto` exists to avoid.
    if (requested === 'auto') {
      const ownerProvider = await chat.providerForGezel(generalist.gezelId, {
        nightShift: Boolean(nightShift),
      });
      if (ownerProvider !== providerName) {
        const ownerTier = await chat.classifyExecutionTier(ownerProvider, generalist.gezelId);
        if (resolveTaskExecutionMode(setting, ownerProvider, ownerTier) !== 'generalist') {
          log.info(
            `[tasks] generalist ${generalist.gezelId} is pinned to ${ownerProvider} (${ownerTier}); running stepwise under auto`,
          );
          return { mode: 'stepwise', ...base, providerName: ownerProvider, tier: ownerTier };
        }
      }
    }
    return { mode: 'generalist', ownerGezelId: generalist.gezelId, ...base };
  });

  // Install a craftbook's bundled scripts into the project's scripts/
  // folder the first time a task is created from it. Idempotent — the
  // provenance marker comment makes re-installs no-ops when the
  // catalog version matches what's on disk. Without this hook the
  // bundledScripts list goes nowhere and onExit script refs error at
  // first call ("script not found").
  const { installCraftbookScripts, installLocalCraftbookScripts } = await import(
    '../scripts/install.js'
  );
  // Owner-step card: one unanswered card per (task, step), attributed to the
  // gezel whose work is under review so the card reads as their hand-over.
  const fileOwnerStepCard = async (
    task: Task,
    step: TaskCraftbookStep,
    reviewed: TaskCraftbookStep | undefined,
  ): Promise<void> => {
    const existing = await store.listProjectQuestions(task.projectId).catch(() => []);
    if (
      existing.some(
        (q) =>
          q.intent?.kind === 'step-awaits-owner' &&
          q.intent.taskRef === task.ref &&
          q.intent.stepId === step.id &&
          !q.answer,
      )
    ) {
      return;
    }
    const returnTo = reviewed && reviewed.id !== step.id ? reviewed : undefined;
    const config = await store.readConfig().catch(() => ({}) as GezelConfig);
    const asker =
      (returnTo ? stepOwnerGezelId(task, returnTo) : undefined) ?? config.meesterGezelId ?? '';
    const outputs = await loadTaskOutputs(store, task);
    const question = ownerStepQuestion({
      task,
      step,
      ...(returnTo ? { returnTo } : {}),
      askerGezelId: asker,
      outputs,
      figures: await reviewTaskFigures(store, task, outputs).catch(() => null),
    });
    await store.writeQuestion(question);
    chatEvents.publishProjectEvent(task.projectId, { type: 'question_asked', question });
    log.info(`[tasks] ${task.ref} step "${step.id}" waits for the owner; filed a card`);
  };
  tasks.setTaskCreatedHook(async ({ projectId, task, sources }) => {
    // A task that opens on an owner step (approve the plan first) never
    // passes through the activation hook, so its card is filed here.
    const entry = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    if (task.status === 'active' && entry && isOwnerStep(entry)) {
      await fileOwnerStepCard(task, entry, undefined).catch((err) =>
        log.warn(`[service] owner-step card failed for ${task.ref}: ${String(err)}`),
      );
    }
    if (task.status === 'active') introduceAtKickoff(task, entry);
    // A book that verifies its work by running project commands
    // (`commandEvidence` gates) declares them as `commands` needs; raise
    // their first-use approval questions NOW so the user answers at
    // launch instead of the run stalling steps later. Fire-and-forget —
    // an unanswered question just means the mid-task path asks again.
    if (task.craftbook.commands && task.craftbook.commands.length > 0) {
      await ensureCommandApprovalQuestions({
        store,
        home,
        projectId,
        needs: task.craftbook.commands,
        requestedBy: `The "${task.craftbook.name}" craftbook (task ${task.ref})`,
      }).catch((err) => {
        log.warn(`[tasks] kickoff command approvals for ${task.ref} failed: ${String(err)}`);
      });
    }
    for (const src of sources) {
      // Local craftbooks (editor-authored) carry their scripts on disk —
      // copy from the local template dir rather than the bundled catalog.
      if (src.sourceId === 'local') {
        await installLocalCraftbookScripts(
          home,
          projectId,
          src.catalogId,
          src.version ?? '1.0.0',
        ).catch((err) => {
          log.warn(
            `[tasks] failed to install local craftbook scripts for ${src.catalogId}: ${err instanceof Error ? err.message : err}`,
          );
        });
        continue;
      }
      const detail = await catalog
        .get('craftbook-template', src.catalogId, src.sourceId, src.version)
        .catch(() => null);
      if (!detail || detail.manifest.kind !== 'craftbook-template') continue;
      await installCraftbookScripts(home, projectId, detail.manifest, catalog).catch((err) => {
        log.warn(
          `[tasks] failed to install craftbook scripts for ${src.catalogId}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  });

  return { introduceFreshHire, fileOwnerStepCard, resolveRole: roleResolverClosure };
}
