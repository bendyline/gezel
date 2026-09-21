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
import {
  EnsureGezelInputSchema,
  ListDirectoryInputSchema,
  ReadDocumentInputSchema,
  ReadTaskNotesInputSchema,
  WriteDocumentInputSchema,
  WriteTaskNoteInputSchema,
} from '../tools/inputs.js';
import { unionStepKit } from '../tools/step-kit.js';
import { applyStepToolPolicy } from '../tools/step-policy.js';
import { WorkspaceEditError } from '../workspace-edit-error.js';
import { computeReplaceInFile, computeReplaceLines } from '../workspace-edits.js';
import type { PortableStore } from './store.js';
import { assertPortableTaskSessionActive } from './task-authority.js';
import { taskActiveAssignee } from './tasks.js';

const path = z.string().min(1).max(2000);
const text = z.string().max(128_000);
const empty = z.object({}).strict();
const project = z.string().optional();
const definitions = {
  ask_user_question: {
    description:
      'Ask the user a question and end your turn. Their answer arrives in this conversation. Include choices for bounded decisions.',
    input: AskQuestionRequestSchema.omit({
      projectId: true,
      gezelId: true,
      sessionId: true,
      prompt: true,
    })
      .extend({ question: z.string().min(1).max(128_000) })
      .strict(),
  },
  list_gilde: { description: 'List bundled crew templates.', input: empty },
  create_task: {
    description: 'Create a task with explicit steps in this project.',
    input: z
      .object({
        title: z.string(),
        description: z.string().min(40),
        steps: z
          .array(
            z.object({ name: z.string(), prompt: z.string(), terminal: z.boolean().optional() }),
          )
          .min(1)
          .max(12),
        assignee: z.object({ kind: z.literal('gezel'), gezelId: z.string() }).optional(),
      })
      .strict(),
  },
  advance_task_step: {
    description: 'Check the completion gate and advance the active task step.',
    input: z
      .object({ ref: z.string(), stepId: z.string().optional(), next: z.string().optional() })
      .strict(),
  },
  list_gezels: { description: 'List the named crew.', input: empty },
  ensure_gezel: {
    description: 'Reuse or recruit a gezel for a job.',
    input: EnsureGezelInputSchema,
  },
  list_projects: { description: 'List projects and their ids.', input: empty },
  update_project: {
    description: 'Update project brief, objectives or lead.',
    input: UpdateProjectRequestSchema.pick({
      name: true,
      description: true,
      about: true,
      missionObjectives: true,
      voormanGezelId: true,
    })
      .extend({ id: z.string() })
      .strict(),
  },
  start_project: {
    description: 'Create a project, lead and kickoff task, then hand off the brief.',
    input: z
      .object({
        name: z.string().min(1).max(200),
        about: text.optional(),
        missionObjectives: text.optional(),
        taskDescription: text.optional(),
        taskTitle: z.string().optional(),
        kickoffMessage: text.optional(),
      })
      .strict(),
  },
  list_project_gezels: {
    description: 'List this project crew.',
    input: z.object({ project }).strict(),
  },
  add_gezel_to_project: {
    description: 'Add an existing gezel to a project.',
    input: z.object({ project: z.string(), gezel: z.string() }).strict(),
  },
  message_gezel: {
    description:
      'Hand work to a crew member; the reply appears in their conversation. End your turn after sending.',
    input: z.object({ gezel: z.string(), project, message: text.min(1) }).strict(),
  },
  list_dir: { description: 'List workspace files.', input: ListDirectoryInputSchema },
  read_file: {
    description: 'Read a workspace text file.',
    input: z
      .object({
        path,
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
  },
  write_file: {
    description: 'Write a workspace text file.',
    input: z.object({ path, content: text }).strict(),
  },
  append_to_file: {
    description:
      'Append only the missing tail to an existing workspace file. Set create:true explicitly to create a missing file.',
    input: z.object({ path, content: text, create: z.boolean().optional() }).strict(),
  },
  replace_in_file: {
    description:
      'Edit an existing workspace file with a literal find/replace. By default exactly one match is required; occurrence selects a 1-based match or all. Returns the saved path and size.',
    input: z
      .object({
        path,
        find: text.min(1),
        replace: text,
        occurrence: z.union([z.number().int().positive(), z.literal('all')]).optional(),
      })
      .strict(),
  },
  replace_lines: {
    description:
      'Replace an inclusive 1-based line range in an existing workspace file. Empty content deletes the range. Read current line numbers after each edit.',
    input: z
      .object({
        path,
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        content: text,
      })
      .strict(),
  },
  list_artifacts: { description: 'List project artifacts.', input: ListDirectoryInputSchema },
  read_artifact: { description: 'Read a project artifact.', input: ReadDocumentInputSchema },
  write_artifact: {
    description: 'Save supporting notes or a report to the project artifacts.',
    input: WriteDocumentInputSchema,
  },
  list_documents: {
    description: 'List the shared document library.',
    input: ListDirectoryInputSchema,
  },
  read_document: { description: 'Read a shared text document.', input: ReadDocumentInputSchema },
  write_document: {
    description: 'Save shared guidelines or reference text.',
    input: WriteDocumentInputSchema,
  },
  search: {
    description: 'Search text in this project.',
    input: z
      .object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(20).optional() })
      .strict(),
  },
  search_memory: {
    description: 'Search your own or this project memories.',
    input: z
      .object({ query: z.string().min(1), scope: z.enum(['gezel', 'project']).optional() })
      .strict(),
  },
  save_memory: {
    description: 'Save a durable note for yourself or this project.',
    input: z.object({ text: text.min(1), scope: z.enum(['gezel', 'project']).optional() }).strict(),
  },
  read_task_notes: {
    description: 'Read dated task notes, newest first. Omit stepId for the complete feed.',
    input: ReadTaskNotesInputSchema,
  },
  write_task_note: {
    description: 'Append a focused dated note to the current task, attributed to you.',
    input: WriteTaskNoteInputSchema,
  },
  list_tasks: { description: 'List tasks in this project.', input: empty },
  get_task: {
    description: 'Read a task and its steps.',
    input: z.object({ ref: z.string() }).strict(),
  },
  list_scripts: {
    description:
      'List installed project, user and standard scripts with input fields and required capabilities.',
    input: z.object({ project }).strict(),
  },
  run_installed_script: {
    description:
      'Run an installed script by name from list_scripts. Default scope is project. Input is validated; declared capabilities and project policy are enforced.',
    input: z
      .object({
        name: z.string(),
        project,
        scope: z.enum(['project', 'user', 'standard']).optional(),
        input: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  },
  get_script_run: {
    description: 'Read a persisted script run, output, logs and call audit.',
    input: z.object({ project, runId: z.string() }).strict(),
  },
} as const;
export type PortableToolName = keyof typeof definitions;
export function portableToolNames(): ReadonlySet<string> {
  return new Set(Object.keys(definitions));
}

export interface PortableToolActions {
  askQuestion?(
    input: Omit<AskQuestionRequest, 'projectId' | 'gezelId' | 'sessionId'>,
  ): Promise<{ questionId: string; deduped?: boolean }>;
  recruit(role: string): Promise<{ id: string; name: string; role?: string }>;
  templates(): unknown;
  createTask(input: CreateTaskRequest): Promise<unknown>;
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
    const { question, ...rest } = args;
    return actions.askQuestion({ ...rest, prompt: String(question) });
  }
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
  if (name === 'create_task') return actions.createTask(CreateTaskRequestSchema.parse(args));
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
  if (name === 'start_project')
    return actions.startProject(args as Parameters<PortableToolActions['startProject']>[0]);
  if (name === 'message_gezel') {
    const gezels = await store.listGezels();
    const member =
      gezels.find((g) => g.id === args.gezel) ??
      gezels.find((g) => g.name.toLowerCase() === String(args.gezel).toLowerCase());
    if (!member || member.id === session.gezelId) throw new Error('Choose another available gezel');
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
  if (name === 'list_tasks')
    return { tasks: await store.listTasks({ projectId: session.projectId }) };
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
      maxResults: args.maxResults as number | undefined,
    });
  if (name === 'save_memory' || name === 'search_memory') {
    const scope = args.scope === 'project' ? 'project' : 'gezel';
    const id = scope === 'project' ? session.projectId : session.gezelId;
    return name === 'save_memory'
      ? store.saveMemory({ scope, id, text: String(args.text) })
      : store.searchMemories({
          gezelId: session.gezelId,
          projectId: session.projectId,
          query: String(args.query),
        });
  }
  const area =
    name.endsWith('document') || name === 'list_documents'
      ? 'documents'
      : name.endsWith('artifact') || name === 'list_artifacts'
        ? 'artifacts'
        : 'workspace';
  const projectId = area === 'documents' ? undefined : session.projectId;
  if (name.startsWith('list_'))
    return store.listFiles(area, projectId, args.path === '.' ? '' : String(args.path ?? ''));
  if (name.startsWith('read_')) {
    const content = await store.readFile(area, projectId, String(args.path));
    if (content === null) throw new Error('File not found');
    const lines = content.split('\n');
    const offset = Number(args.offset ?? 1);
    const end = offset - 1 + Number(args.limit ?? 120);
    return {
      path: args.path,
      content: lines.slice(offset - 1, end).join('\n'),
      totalLines: lines.length,
      truncated: end < lines.length,
    };
  }
  if (name.startsWith('write_')) {
    await store.writeFile(area, projectId, String(args.path), String(args.content));
    return { path: args.path, written: true };
  }
  throw new Error(`Tool ${name} is not implemented`);
}
