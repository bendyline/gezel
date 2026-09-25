import { z } from 'zod';
import { isEngagementAllowed } from '../engagement.js';
import {
  type AskQuestionRequest,
  AskQuestionRequestSchema,
  UpdateProjectRequestSchema,
} from '../schemas/api.js';
import type { ScriptScope } from '../schemas/script.js';
import type { ChatSession } from '../schemas/session.js';
import { type CreateTaskRequest, CreateTaskRequestSchema } from '../schemas/task.js';
import { roleHasTeamScope, roleToolNames } from '../tools/access.js';
import { TOOL_DESCRIPTIONS } from '../tools/descriptions.js';
import {
  AddGezelToProjectInputSchema,
  AdvanceTaskStepInputSchema,
  AppendToFileInputSchema,
  AskUserQuestionInputSchema,
  CreateTaskInputSchema,
  EmptyInputSchema,
  EnsureGezelInputSchema,
  GetScriptRunInputSchema,
  GetTaskInputSchema,
  ListArtifactsInputSchema,
  ListDirectoryInputSchema,
  ListDocumentsInputSchema,
  ListProjectGezelsInputSchema,
  ListScriptsInputSchema,
  ListTasksInputSchema,
  MessageGezelInputSchema,
  ReadDocumentInputSchema,
  ReadFileInputSchema,
  ReadTaskNotesInputSchema,
  ReplaceInFileInputSchema,
  ReplaceLinesInputSchema,
  RunInstalledScriptInputSchema,
  SaveMemoryInputSchema,
  SearchInputSchema,
  SearchMemoryInputSchema,
  StartProjectInputSchema,
  UpdateProjectInputSchema,
  WriteDocumentInputSchema,
  WriteFileInputSchema,
  WriteTaskNoteInputSchema,
} from '../tools/inputs.js';
import { unionStepKit } from '../tools/step-kit.js';
import { applyStepToolPolicy } from '../tools/step-policy.js';
import { WorkspaceEditError } from '../workspace-edit-error.js';
import { computeReplaceInFile, computeReplaceLines } from '../workspace-edits.js';
import type { PortableStore } from './store.js';
import { assertPortableTaskSessionActive } from './task-authority.js';
import { taskActiveAssignee } from './tasks.js';

const definitions = {
  ask_user_question: {
    description: TOOL_DESCRIPTIONS.ask_user_question,
    input: AskUserQuestionInputSchema,
  },
  list_gilde: { description: TOOL_DESCRIPTIONS.list_gilde, input: EmptyInputSchema },
  create_task: { description: TOOL_DESCRIPTIONS.create_task, input: CreateTaskInputSchema },
  advance_task_step: {
    description: TOOL_DESCRIPTIONS.advance_task_step,
    input: AdvanceTaskStepInputSchema,
  },
  list_gezels: { description: TOOL_DESCRIPTIONS.list_gezels, input: EmptyInputSchema },
  ensure_gezel: { description: TOOL_DESCRIPTIONS.ensure_gezel, input: EnsureGezelInputSchema },
  list_projects: { description: TOOL_DESCRIPTIONS.list_projects, input: EmptyInputSchema },
  update_project: {
    description: TOOL_DESCRIPTIONS.update_project,
    input: UpdateProjectInputSchema,
  },
  start_project: { description: TOOL_DESCRIPTIONS.start_project, input: StartProjectInputSchema },
  list_project_gezels: {
    description: TOOL_DESCRIPTIONS.list_project_gezels,
    input: ListProjectGezelsInputSchema,
  },
  add_gezel_to_project: {
    description: TOOL_DESCRIPTIONS.add_gezel_to_project,
    input: AddGezelToProjectInputSchema,
  },
  message_gezel: { description: TOOL_DESCRIPTIONS.message_gezel, input: MessageGezelInputSchema },
  list_dir: { description: TOOL_DESCRIPTIONS.list_dir, input: ListDirectoryInputSchema },
  read_file: { description: TOOL_DESCRIPTIONS.read_file, input: ReadFileInputSchema },
  write_file: { description: TOOL_DESCRIPTIONS.write_file, input: WriteFileInputSchema },
  append_to_file: { description: TOOL_DESCRIPTIONS.append_to_file, input: AppendToFileInputSchema },
  replace_in_file: {
    description: TOOL_DESCRIPTIONS.replace_in_file,
    input: ReplaceInFileInputSchema,
  },
  replace_lines: { description: TOOL_DESCRIPTIONS.replace_lines, input: ReplaceLinesInputSchema },
  list_artifacts: {
    description: TOOL_DESCRIPTIONS.list_artifacts,
    input: ListArtifactsInputSchema,
  },
  read_artifact: { description: TOOL_DESCRIPTIONS.read_artifact, input: ReadDocumentInputSchema },
  write_artifact: {
    description: TOOL_DESCRIPTIONS.write_artifact,
    input: WriteDocumentInputSchema,
  },
  list_documents: {
    description: TOOL_DESCRIPTIONS.list_documents,
    input: ListDocumentsInputSchema,
  },
  read_document: { description: TOOL_DESCRIPTIONS.read_document, input: ReadDocumentInputSchema },
  write_document: {
    description: TOOL_DESCRIPTIONS.write_document,
    input: WriteDocumentInputSchema,
  },
  search: { description: TOOL_DESCRIPTIONS.search, input: SearchInputSchema },
  search_memory: { description: TOOL_DESCRIPTIONS.search_memory, input: SearchMemoryInputSchema },
  save_memory: { description: TOOL_DESCRIPTIONS.save_memory, input: SaveMemoryInputSchema },
  read_task_notes: {
    description: TOOL_DESCRIPTIONS.read_task_notes,
    input: ReadTaskNotesInputSchema,
  },
  write_task_note: {
    description: TOOL_DESCRIPTIONS.write_task_note,
    input: WriteTaskNoteInputSchema,
  },
  list_tasks: { description: TOOL_DESCRIPTIONS.list_tasks, input: ListTasksInputSchema },
  get_task: { description: TOOL_DESCRIPTIONS.get_task, input: GetTaskInputSchema },
  list_scripts: { description: TOOL_DESCRIPTIONS.list_scripts, input: ListScriptsInputSchema },
  run_installed_script: {
    description: TOOL_DESCRIPTIONS.run_installed_script,
    input: RunInstalledScriptInputSchema,
  },
  get_script_run: { description: TOOL_DESCRIPTIONS.get_script_run, input: GetScriptRunInputSchema },
} as const;
export type PortableToolName = keyof typeof definitions;
export function portableToolNames(): ReadonlySet<string> {
  return new Set(Object.keys(definitions));
}
/** The input schema a tool is registered with here, for cross-host contract tests. */
export function portableToolInputSchema(name: string): z.ZodTypeAny | undefined {
  return Object.hasOwn(definitions, name) ? definitions[name as PortableToolName].input : undefined;
}

export interface PortableToolActions {
  askQuestion?(
    input: Omit<AskQuestionRequest, 'projectId' | 'gezelId' | 'sessionId'>,
  ): Promise<{ questionId: string; deduped?: boolean }>;
  recruit(role: string): Promise<{ id: string; name: string; role?: string }>;
  templates(): unknown;
  createTask(input: CreateTaskRequest, projectId: string): Promise<unknown>;
  completeTask(ref: string, next?: string): Promise<unknown>;
  scripts?: {
    list(projectId: string): unknown;
    run(
      name: string,
      inputs: Record<string, unknown>,
      session: ChatSession,
      scope: ScriptScope,
    ): Promise<unknown>;
  };
  /**
   * Refuse a handoff before anything is written. The limit used to be checked
   * inside the handoff itself, after the project or roster change had already
   * committed, so a model that retried on the refusal created the work twice.
   */
  assertHandoffAllowed(gezelId?: string): void;
  message(gezelId: string, projectId: string, message: string): Promise<unknown>;
  startProject(input: {
    name: string;
    about?: string;
    missionObjectives?: string;
    taskDescription?: string;
    taskTitle?: string;
    kickoffMessage?: string;
  }): Promise<unknown>;
}

/** Role grants are shared with desktop. Host capabilities only narrow them. */
export async function portableToolSurface(
  store: PortableStore,
  session: Pick<ChatSession, 'gezelId' | 'projectId' | 'taskRef' | 'stepId'>,
  scripts = false,
) {
  const { gezel, project } = await store.getProjectContext(session.projectId, session.gezelId);
  const task = session.taskRef ? await store.getTask(session.taskRef) : null;
  const step = task?.craftbook.steps.find((item) => item.id === session.stepId);
  // A task session never sheds its persisted step ceiling when the task moves on.
  // Missing/deleted context fails closed instead of restoring the whole role.
  if (session.taskRef && (!task || task.projectId !== session.projectId || !step)) return [];
  const roleGrants = roleToolNames(gezel.role, project.mode);
  if (task?.executionMode === 'generalist' && step) {
    const kit = unionStepKit(step, task.craftbook.steps);
    if (kit) {
      // Generalist continuity carries the union of deterministic step kits.
      // Existing role grants and the current step's policy remain ceilings.
      const keep = new Set([
        ...kit.tools,
        ...(step.toolPolicy?.allowTools ?? []),
        'advance_task_step',
        'ask_user_question',
        'get_task',
        'list_tasks',
        'read_task_notes',
        'write_task_note',
        'list_scripts',
        'run_installed_script',
        'get_script_run',
        'search',
        'read_document',
        'load_memory',
        'save_memory',
      ]);
      for (const name of roleGrants) if (!keep.has(name)) roleGrants.delete(name);
    }
  }
  const grants = applyStepToolPolicy(roleGrants, step)!;

  return (
    Object.entries(definitions) as Array<[PortableToolName, (typeof definitions)[PortableToolName]]>
  )
    .filter(
      ([name]) =>
        grants.has(name) &&
        (scripts || !['list_scripts', 'run_installed_script', 'get_script_run'].includes(name)),
    )
    .map(([name, spec]) => ({
      name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.input, { target: 'openapi-3.0' }),
    }));
}

/** Called only after durable call admission. All mutable grants are checked again. */
export async function executePortableTool(
  store: PortableStore,
  session: ChatSession,
  name: string,
  raw: Record<string, unknown>,
  actions: PortableToolActions,
): Promise<unknown> {
  if (!isEngagementAllowed(await store.readConfig())) throw new Error('AI engagement is off');
  const context = await store.getProjectContext(session.projectId, session.gezelId);
  if (context.project.status === 'inactive') throw new Error('This project is inactive');
  await assertPortableTaskSessionActive(store, session);
  const grants = new Set(
    (await portableToolSurface(store, session, !!actions.scripts)).map((tool) => tool.name),
  );
  if (!grants.has(name as PortableToolName))
    throw new Error(`Tool ${name} is unavailable to this gezel`);
  const args = definitions[name as PortableToolName].input.parse(raw) as Record<string, unknown>;
  const team = roleHasTeamScope(context.gezel.role, context.project.mode);
  const target = typeof args.project === 'string' ? args.project : session.projectId;
  if (target !== session.projectId && !team)
    throw new Error('This gezel cannot act outside its project');
  const readOnly = context.project.status === 'readonly';
  if (
    readOnly &&
    /^(write_|append_|replace_|save_|ensure_|update_|start_|add_|message_|run_|create_|advance_)/.test(
      name,
    )
  )
    throw new Error('This project is read-only');
  if (['update_project', 'add_gezel_to_project', 'message_gezel'].includes(name)) {
    const targetId = name === 'update_project' ? String(args.id) : target;
    const destination = await store.getProject(targetId);
    if (!destination) throw new Error('Project not found');
    if (destination.status === 'readonly' || destination.status === 'inactive')
      throw new Error('The destination project does not accept changes');
  }
  if (name === 'ask_user_question') {
    if (!actions.askQuestion) throw new Error('Questions are unavailable on this host');
    const { question, prompt, description, ...rest } = args;
    const text = [question, prompt, description].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (!text) throw new Error('Provide the question text');
    return actions.askQuestion({ ...rest, prompt: text });
  }
  assertPortableTextBudget(args);
  if (name === 'append_to_file' || name === 'replace_in_file' || name === 'replace_lines') {
    const file = String(args.path);
    return store.editWorkspaceFile(session.projectId, file, (before) => {
      if (before === null && !(name === 'append_to_file' && args.create === true))
        throw new WorkspaceEditError(
          `Cannot edit ${file}: file does not exist. Use write_file to create it first.`,
          'file-not-found',
        );
      if (name === 'append_to_file') return (before ?? '') + String(args.content);
      return name === 'replace_in_file'
        ? computeReplaceInFile(before!, {
            path: file,
            find: String(args.find),
            replace: String(args.replace),
            occurrence: args.occurrence as number | 'all' | undefined,
          })
        : computeReplaceLines(before!, {
            path: file,
            startLine: Number(args.startLine),
            endLine: Number(args.endLine),
            content: String(args.content),
          });
    });
  }
  if (name === 'list_gezels') return { items: await store.listGezels() };
  if (name === 'list_projects') return { items: await store.listProjects() };
  if (name === 'list_project_gezels') return { items: await store.getProjectGezels(target) };
  if (name === 'add_gezel_to_project') {
    await store.addGezelToProject(target, String(args.gezel));
    return { projectId: target, gezelId: args.gezel };
  }
  if (name === 'ensure_gezel') {
    const role = String(args.jobTitle).trim();
    const member = await actions.recruit(role);
    return { gezelId: member.id, name: member.name, role: member.role };
  }
  if (name === 'list_gilde') return actions.templates();
  if (name === 'create_task') {
    // No craftbook catalogue on this host: a task needs its steps spelled out.
    if (!Array.isArray(args.steps) || args.steps.length === 0)
      throw new Error('This host needs the task steps spelled out');
    if (args.steps.length > PORTABLE_MAX_TASK_STEPS)
      throw new Error(`This host runs tasks of at most ${PORTABLE_MAX_TASK_STEPS} steps`);
    const destination = await store.getProject(target);
    if (!destination) throw new Error('Project not found');
    if (destination.status === 'readonly' || destination.status === 'inactive')
      throw new Error('The destination project does not accept changes');
    const { project: _project, ...request } = args;
    return actions.createTask(CreateTaskRequestSchema.parse(request), destination.id);
  }
  if (name === 'advance_task_step') {
    const task = await store.getTask(String(args.ref));
    if (!task || task.projectId !== session.projectId)
      throw new Error('Task is outside this project');
    if (session.taskRef && (session.taskRef !== task.ref || session.stepId !== task.activeStepId))
      throw new Error('Only the current task step can be advanced from this conversation');
    if (args.stepId && args.stepId !== task.activeStepId)
      throw new Error('Only the active task step can be advanced');
    const assignee = taskActiveAssignee(task);
    if (assignee.kind === 'user') throw new Error('This step awaits the user');
    if (assignee.gezelId !== session.gezelId && context.project.voormanGezelId !== session.gezelId)
      throw new Error('Only the active step assignee or project lead can advance this task');
    return actions.completeTask(task.ref, args.next as string | undefined);
  }

  if (name === 'update_project') {
    const { id, ...patch } = args;
    if (!team && id !== session.projectId) throw new Error('Project is out of scope');
    return store.updateProject(String(id), UpdateProjectRequestSchema.parse(patch));
  }
  if (name === 'start_project') {
    // The lead is recruited inside startProject, so this checks the depth and
    // count limits only; the handoff re-checks once the identity exists.
    actions.assertHandoffAllowed();
    return actions.startProject(args as Parameters<PortableToolActions['startProject']>[0]);
  }
  if (name === 'message_gezel') {
    const gezels = await store.listGezels();
    const wanted = typeof args.gezel === 'string' ? args.gezel : args.gezelId;
    if (typeof wanted !== 'string' || !wanted.trim()) throw new Error('Name the gezel to message');
    const member =
      gezels.find((g) => g.id === wanted) ??
      gezels.find((g) => g.name.toLowerCase() === wanted.toLowerCase());
    if (!member || member.id === session.gezelId) throw new Error('Choose another available gezel');
    // Check before the roster write, not after: a refusal must leave nothing behind.
    actions.assertHandoffAllowed(member.id);
    await store.addGezelToProject(target, member.id);
    return actions.message(member.id, target, String(args.message));
  }
  if (name === 'read_task_notes' || name === 'write_task_note') {
    const task = await store.getTask(String(args.ref));
    if (!task || task.projectId !== session.projectId)
      throw new Error('Task is outside this project');
    if (name === 'read_task_notes') {
      const stepId = typeof args.stepId === 'string' ? args.stepId.trim() : undefined;
      const notes = (await store.listTaskNotes(task.ref))
        .filter((note) => !stepId || note.stepId === stepId)
        .reverse();
      return { operation: 'read_notes', ref: task.ref, count: notes.length, details: { notes } };
    }
    if (session.taskRef && session.taskRef !== task.ref)
      throw new Error('Write notes to the current task');
    const body = args.text ?? args.note ?? args.content;
    if (typeof body !== 'string' || !body.trim())
      throw new Error('Provide the note body as text, note, or content');
    const stepId = (args.stepId as string | undefined) ?? session.stepId;
    if (session.stepId && stepId !== session.stepId)
      throw new Error('Write notes to the current step');
    const note = await store.appendTaskNote(task.ref, body, stepId, session.gezelId);
    return { operation: 'write_note', ref: task.ref, ...(stepId ? { stepId } : {}), note };
  }
  if (name === 'list_tasks') {
    const tasks = (await store.listTasks({ projectId: target })).filter(
      (task) =>
        (!args.status || task.status === args.status) &&
        (!args.assignee ||
          (task.assignee.kind === 'gezel' && task.assignee.gezelId === args.assignee)),
    );
    return { tasks };
  }
  if (name === 'get_task') {
    const task = await store.getTask(String(args.ref));
    if (!task || (task.projectId !== session.projectId && !team))
      throw new Error('Task is not available in this project');
    return task;
  }
  if (name === 'list_scripts') return actions.scripts!.list(target);
  if (name === 'get_script_run') {
    const run = await store.getScriptRun(target, String(args.runId));
    if (!run) throw new Error('Script run not found in this project');
    return run;
  }
  if (name === 'run_installed_script') {
    const destination = await store.getProject(target);
    if (!destination || destination.status === 'readonly' || destination.status === 'inactive')
      throw new Error('The destination project does not accept changes');
    return actions.scripts!.run(
      String(args.name),
      (args.input ?? {}) as Record<string, unknown>,
      { ...session, projectId: target },
      (args.scope as ScriptScope | undefined) ?? 'project',
    );
  }
  if (name === 'search')
    return store.searchProject(session.projectId, {
      query: String(args.query),
      // The contract allows up to 100; this host can afford 20.
      maxResults: Math.min(20, (args.maxResults as number | undefined) ?? 20),
    });
  if (name === 'save_memory' || name === 'search_memory') {
    const scope = args.scope === 'project' ? 'project' : 'gezel';
    const id = scope === 'project' ? session.projectId : session.gezelId;
    if (name === 'save_memory') return store.saveMemory({ scope, id, text: String(args.text) });
    const found = await store.searchMemories({
      gezelId: session.gezelId,
      projectId: session.projectId,
      query: String(args.query),
    });
    const topK = typeof args.topK === 'number' ? args.topK : 10;
    return Array.isArray(found) ? found.slice(0, topK) : found;
  }
  const area =
    name.endsWith('document') || name === 'list_documents'
      ? 'documents'
      : name.endsWith('artifact') || name === 'list_artifacts'
        ? 'artifacts'
        : 'workspace';
  const projectId = area === 'documents' ? undefined : session.projectId;
  if (name.startsWith('list_'))
    return store.listFiles(
      area,
      projectId,
      args.path === '.' ? '' : String(args.path ?? ''),
      // The artifacts drawer walks its subtree by default; the others list one level.
      typeof args.recursive === 'boolean' ? args.recursive : name === 'list_artifacts',
    );
  if (name.startsWith('read_')) {
    const content = await store.readFile(area, projectId, String(args.path));
    if (content === null) throw new Error('File not found');
    const lines = content.split('\n');
    // The same range contract as the desktop: 1-based, inclusive, whole file by default.
    const startLine = typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.endLine === 'number' ? args.endLine : lines.length;
    return {
      path: args.path,
      content: lines.slice(startLine - 1, endLine).join('\n'),
      totalLines: lines.length,
      truncated: endLine < lines.length,
    };
  }
  if (name.startsWith('write_')) {
    const content = artifactText(args);
    await store.writeFile(area, projectId, String(args.path), content);
    return { path: args.path, written: true };
  }
  throw new Error(`Tool ${name} is not implemented`);
}

/** Host budgets: the shared contracts carry no size caps, this device does. */
export const PORTABLE_MAX_TEXT_CHARS = 128_000;
export const PORTABLE_MAX_TASK_STEPS = 12;

function assertPortableTextBudget(args: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(args))
    if (typeof value === 'string' && value.length > PORTABLE_MAX_TEXT_CHARS)
      throw new Error(`${key} exceeds this host's ${PORTABLE_MAX_TEXT_CHARS}-character limit`);
}

/** `write_artifact` takes text, a structured value, or `jsonContent`; the rest take text. */
function artifactText(args: Record<string, unknown>): string {
  const value = args.jsonContent ?? args.content;
  if (typeof value === 'string') return value;
  if (value !== undefined && value !== null) return `${JSON.stringify(value, null, 2)}\n`;
  throw new Error('Provide content or jsonContent');
}
