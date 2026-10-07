import { effectiveGeneralistModeSetting, resolveGeneralistKickoff } from '../generalist-mode.js';
import { profileHasBehavior } from '../local-loop/profile.js';
import type { LocalModelTier } from '../model-profile/local-model-tier.js';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import { isOutsideInInternalPath } from '../outside-in-paths.js';
import { leanSession } from '../project-types/composition.js';
import {
  type BuiltInstructions,
  type PromptTaskContext,
  buildInstructions,
} from '../prompt/instructions.js';
import { formatTaskNotesDigest, newestTaskNotesFirst } from '../prompt/task-notes-digest.js';
import type { AvailableToolInfo } from '../prompt/tools-block.js';
import type { GezelConfig } from '../schemas/api.js';
import type { GezelDetail, GezelSummary } from '../schemas/gezel.js';
import type { ProjectDetail, ProjectFileEntry } from '../schemas/project.js';
import type { ChatSession } from '../schemas/session.js';
import { type Task, taskEffectiveStatus, withEffectiveTaskStatuses } from '../schemas/task.js';
import { projectManagedWorkspaceWritable } from '../security/policy.js';
import { isSharedLibraryProject } from '../shared-project.js';
import { isOwnerStep } from '../task-execution.js';
import { BUILTIN_TOOLSETS } from '../tools/builtin-groups.js';
import type { PortableStore } from './store.js';

/** The desktop walker's limits for the prompt's workspace inventory. */
const LISTING_MAX_ENTRIES = 500;
const LISTING_MAX_DEPTH = 6;

export interface PortableInstructionsInput {
  store: PortableStore;
  config: GezelConfig;
  session: ChatSession;
  context: {
    project: ProjectDetail;
    gezel: GezelDetail;
    crew: GezelSummary[];
    sharedProjectId: string | null;
  };
  task?: Task;
  /** The catalog id when known, which is what the desktop names the model by. */
  modelId: string;
  tier: LocalModelTier;
  profile: ResolvedModelProfile;
  /** The tools this turn wires, by name. */
  toolNames: readonly string[];
  /** The phone's footprint for this window; only `minimal` changes the desktop builder. */
  minimalContext: boolean;
  /** The app previews the project's HTML pages itself. */
  inAppWebPreview?: boolean;
}

/**
 * The desktop's system prompt for a phone llama.cpp turn: the same builder,
 * fed from the phone's store the way the chat manager feeds it from the
 * daemon's. Layers the phone has no source for (recall, the index-derived
 * gestalt, connectors, third-party toolsets) are left absent, which is how
 * those layers switch themselves off on the desktop too.
 */
export async function buildPortableInstructions(
  input: PortableInstructionsInput,
): Promise<BuiltInstructions> {
  const { store, config, session, context, profile } = input;
  const { project, gezel } = context;
  const voorman = project.voormanGezelId
    ? context.crew.find((member) => member.id === project.voormanGezelId)
    : undefined;
  const sessionIsLibrary = isSharedLibraryProject(project);
  const [workspace, documents, lessons, task, assignedTasks] = await Promise.all([
    store
      .listFiles('workspace', project.id, '', true)
      .then(promptListing)
      .catch(() => ({ entries: [], truncated: false })),
    sessionIsLibrary || !context.sharedProjectId
      ? { entries: [], truncated: false }
      : store
          .listFiles('documents', undefined, '', true)
          .then(promptListing)
          .catch(() => ({ entries: [], truncated: false })),
    store.readMemoryLessons(gezel.id).catch(() => ''),
    input.task ? taskContext(store, session, input.task) : undefined,
    session.taskRef ? [] : assignedTo(store, session),
  ]);
  const documentFiles = documents.entries.filter((entry) => !isOutsideInInternalPath(entry.path));
  const traits = gezel.parsed.frontmatter.traits?.map((trait) => trait.text) ?? [];
  const step = task?.step;
  return buildInstructions({
    name: gezel.name,
    roleBasedNameOnlyMode: session.roleBasedNameOnlyMode ?? config.roleBasedNameOnlyMode ?? false,
    gezelId: gezel.id,
    about: gezel.about,
    ...(lessons.trim() ? { lessons: lessons.trim() } : {}),
    ...(traits.length ? { traits } : {}),
    role: gezel.role,
    providerName: 'llama-cpp',
    generalistKickoff: resolveGeneralistKickoff(
      effectiveGeneralistModeSetting(config),
      'llama-cpp',
      input.tier,
    ),
    project,
    hasObservationTables: false,
    workspaceFiles: workspace.entries,
    ...(workspace.truncated ? { workspaceFilesTruncated: true } : {}),
    documentFiles,
    ...(documents.truncated ? { documentFilesTruncated: true } : {}),
    voormanName: voorman?.name,
    ...(voorman?.roleBasedName ? { voormanRoleBasedName: voorman.roleBasedName } : {}),
    ...(voorman?.gender ? { voormanGender: voorman.gender } : {}),
    task,
    assignedTasks,
    recallBlock: '',
    localModelTier: input.tier,
    modelId: input.modelId,
    profile,
    installedToolsetIds: new Set<string>(),
    availableTools: promptTools(input.toolNames),
    thirdPartyToolsetIds: [],
    ...(gezel.toolsMd ? { toolsMd: gezel.toolsMd } : {}),
    ...(session.consultationMode ? { consultationMode: true } : {}),
    ...(session.expectedDeliverable ? { expectedDeliverable: session.expectedDeliverable } : {}),
    ...(profileHasBehavior(profile, 'prompt.executor-context-trim')
      ? { trimExecutorContext: true }
      : {}),
    ...(input.minimalContext ? { minimalContext: true } : {}),
    ...(input.inAppWebPreview ? { inAppWebPreview: true } : {}),
    ...(step?.promptProfile === 'focused' ? { focusedTaskContext: true } : {}),
    ...(leanSession(project, session) ? { leanProfile: true } : {}),
    ...(profileHasBehavior(profile, 'prompt.retrieval-first') ? { retrievalFirstHint: true } : {}),
    workspaceWritable: projectManagedWorkspaceWritable(project) || Boolean(input.task?.diffpackId),
    // The desktop's llama.cpp default. Templates that allow one system
    // message are merged by the loop, as they are there.
    layeredPrefixCache: true,
  });
}

/**
 * The tools as the desktop predicts them for the prompt: in built-in group
 * order, first group wins, descriptions left to the tools block.
 */
function promptTools(names: readonly string[]): AvailableToolInfo[] {
  const wired = new Set(names);
  const seen = new Set<string>();
  const tools: AvailableToolInfo[] = [];
  for (const group of BUILTIN_TOOLSETS) {
    for (const name of group.tools) {
      if (!wired.has(name) || seen.has(name)) continue;
      seen.add(name);
      tools.push({ name, description: '' });
    }
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    tools.push({ name, description: '' });
  }
  return tools;
}

/**
 * The desktop's inventory order and limits: breadth first, shallow entries
 * before deep ones, at most 500 entries and six levels.
 */
function promptListing(listing: { entries: ProjectFileEntry[]; truncated: boolean }): {
  entries: ProjectFileEntry[];
  truncated: boolean;
} {
  const depth = (path: string) => path.split('/').length - 1;
  const eligible = listing.entries
    .filter((entry) => depth(entry.path) <= LISTING_MAX_DEPTH)
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  return {
    entries: eligible.slice(0, LISTING_MAX_ENTRIES),
    truncated: listing.truncated || eligible.length > LISTING_MAX_ENTRIES,
  };
}

async function taskContext(
  store: PortableStore,
  session: ChatSession,
  task: Task,
): Promise<PromptTaskContext> {
  const step =
    (session.stepId && task.craftbook.steps.find((s) => s.id === session.stepId)) ||
    task.craftbook.steps.find((s) => s.id === task.activeStepId);
  const all = newestTaskNotesFirst(await store.listTaskNotes(task.ref).catch(() => []));
  const scopedStepId = session.stepId && step?.id === session.stepId ? session.stepId : null;
  const notes = formatTaskNotesDigest(
    scopedStepId ? all.filter((note) => note.stepId !== scopedStepId) : all,
  );
  const stepNotes = scopedStepId
    ? formatTaskNotesDigest(all.filter((note) => note.stepId === scopedStepId))
    : '';
  return {
    task,
    ...(step ? { step } : {}),
    ...(notes ? { notes } : {}),
    ...(stepNotes ? { stepNotes } : {}),
  };
}

/** Open work waiting on this gezel in this project, as the desktop lists it. */
async function assignedTo(store: PortableStore, session: ChatSession): Promise<Task[]> {
  const all = withEffectiveTaskStatuses(
    await store.listTasks({ projectId: session.projectId }).catch(() => []),
  );
  return all.filter((task) => {
    const status = taskEffectiveStatus(task);
    if (status !== 'active' && status !== 'paused') return false;
    if (task.cron || task.nightShift?.enabled) return false;
    const activeStep = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    if (isOwnerStep(activeStep)) return false;
    if (task.assignee.kind === 'gezel' && task.assignee.gezelId === session.gezelId) return true;
    if (activeStep?.assignee?.kind === 'gezel' && activeStep.assignee.gezelId === session.gezelId)
      return true;
    return activeStep?.suggestedGezelId === session.gezelId;
  });
}
