import type { GezelConfig } from '../schemas/api.js';
import type {
  GetScriptSourceResponse,
  ScriptDiagnostic,
  ScriptMeta,
  ScriptRun,
  ScriptRunTrigger,
  ScriptScope,
  ScriptTemplateId,
  SdkTypesResponse,
} from '../schemas/script.js';
import { toScriptTaskStep } from '../scripts/task-step.js';
import { projectManagedWorkspaceWritable, resolveSecurityPolicy } from '../security/policy.js';
import { validatePortablePath } from './files.js';
import type { PortableFileArea } from './project-files.js';
import type { PortableScriptTaskActions } from './script-tasks.js';
import type { PortableStore } from './store.js';
import { assertPortableTaskSessionActive } from './task-authority.js';

export interface PortableScriptTaskContext {
  projectId: string;
  signal: AbortSignal;
  trigger?: ScriptRunTrigger;
  /** Recheck the runner's live admission ceiling before a delayed host effect. */
  authorizeMethod?(method: string): Promise<void>;
  /** In-memory host callback. Never exposed through the guest's serialized SDK. */
  runTaskScript?(request: {
    scriptName: string;
    scope?: ScriptScope;
    inputs?: Record<string, unknown>;
    trigger: Extract<ScriptRunTrigger, { kind: 'step' }>;
    signal: AbortSignal;
  }): Promise<ScriptRun>;
}

/** Host-facing contract; the core never imports an execution engine. */
export interface PortableScripts {
  setTaskActions?(actions: PortableScriptTaskActions): void;
  authoring?: {
    inspect(
      source: string,
      name: string,
    ): Promise<{ meta?: ScriptMeta; diagnostics: ScriptDiagnostic[] }>;
    scaffold(name: string, description?: string, template?: ScriptTemplateId): Promise<string>;
    sdkTypes(): SdkTypesResponse;
  };
  list(): ScriptMeta[];
  source(name: string): Promise<GetScriptSourceResponse>;
  run(options: {
    projectId: string;
    scriptName: string;
    scope?: ScriptScope;
    inputs?: Record<string, unknown>;
    trigger: ScriptRunTrigger;
    signal?: AbortSignal;
    timeoutMs?: number;
    depth?: number;
  }): Promise<ScriptRun>;
  initialize(): Promise<void>;
  cancel(): Promise<void>;
  isBusy(): boolean;
}

export class PortableScriptHost {
  private taskActions: PortableScriptTaskActions | undefined;
  constructor(private readonly store: PortableStore) {}
  setTaskActions(actions: PortableScriptTaskActions) {
    this.taskActions = actions;
  }
  readConfig = (): Promise<GezelConfig> => this.store.readConfig();
  persistRun = (run: ScriptRun) => this.store.writeScriptRun(run);
  workspaceWriteAllowed = async (projectId: string) => {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found');
    return {
      ok: project.status !== 'readonly' && projectManagedWorkspaceWritable(project),
      reason: 'gezel workspace writes are turned off for this project',
    };
  };

  dispatch = async (
    context: PortableScriptTaskContext,
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    const text = (key: string, optional = false) => {
      const value = p[key];
      if (optional && value === undefined) return '';
      if (typeof value !== 'string') throw new Error(`Expected string parameter "${key}"`);
      return value;
    };
    const check = () => {
      if (context.signal.aborted) throw new Error('Script execution cancelled');
    };
    check();
    if (!(await this.store.getProject(context.projectId))) throw new Error('Project not found');
    if (context.trigger?.kind === 'chat') {
      const session = await this.store.getSession(
        context.trigger.gezelId,
        context.trigger.sessionId,
      );
      if (!session || session.projectId !== context.projectId)
        throw new Error('The script session is out of scope');
      await assertPortableTaskSessionActive(this.store, session);
    }
    if (method === 'task.create' || method === 'task.update' || method === 'task.advance') {
      if (!this.taskActions) throw new Error('Task mutation is unavailable on this host');
      if (method === 'task.create') return this.taskActions.create(context, p.req);
      if (method === 'task.update') return this.taskActions.update(context, text('ref'), p.patch);
      return this.taskActions.advance(
        context,
        text('ref'),
        text('nextPhaseName', true) || undefined,
      );
    }
    if (method.startsWith('task.')) {
      const raw = text('ref');
      const ref = raw.includes('/') ? raw : `${context.projectId}/${raw}`;
      const task = await this.store.getTask(ref);
      if (!task || task.projectId !== context.projectId)
        throw new Error('Task is outside this project');
      const steps = task.craftbook.steps.map((step) => toScriptTaskStep(step, task.activeStepId));
      if (method === 'task.get') return task;
      if (method === 'task.steps') return steps;
      if (method === 'task.currentStep') return steps.find((step) => step.isActive) ?? null;
      if (method === 'task.readNotes') {
        const phaseId = text('phaseId', true);
        return (await this.store.listTaskNotes(ref))
          .filter((note) => !phaseId || note.stepId === phaseId)
          .map((note) => note.text)
          .join('\n\n');
      }
      if (method === 'task.appendNote' || method === 'task.writeNotes') {
        const trigger = context.trigger;
        let stepId = text(method === 'task.appendNote' ? 'stepId' : 'phaseId', true) || undefined;
        let actor: string | undefined;
        let expectedActiveStepId: string | undefined;
        if (trigger?.kind === 'step') {
          if (trigger.taskRef !== ref || (stepId && stepId !== trigger.stepId))
            throw new Error('Write notes to the current task and step');
          if (task.status !== 'active' || task.activeStepId !== trigger.stepId)
            throw new Error('The task step has stopped or changed');
          stepId ??= trigger.stepId;
          expectedActiveStepId = trigger.stepId;
        } else if (trigger?.kind === 'chat') {
          const session = await this.store.getSession(trigger.gezelId, trigger.sessionId);
          if (!session || session.projectId !== context.projectId)
            throw new Error('The script session is out of scope');
          if (
            (session.taskRef && session.taskRef !== ref) ||
            (session.stepId && stepId && session.stepId !== stepId)
          )
            throw new Error('Write notes to the current task and step');
          stepId ??= session.stepId;
          actor = trigger.gezelId;
          expectedActiveStepId = session.stepId;
        }
        check();
        const note = await this.store.appendTaskNote(
          ref,
          text(method === 'task.appendNote' ? 'text' : 'content'),
          stepId,
          actor,
          expectedActiveStepId,
        );
        return method === 'task.appendNote' ? note : undefined;
      }
      throw new Error(`SDK method "${method}" is unavailable on this device`);
    }
    const area: PortableFileArea = method.startsWith('fs.')
      ? 'workspace'
      : method.startsWith('artifact.')
        ? 'artifacts'
        : method.startsWith('document.')
          ? 'documents'
          : (() => {
              throw new Error(`SDK method "${method}" is unavailable on this device`);
            })();
    const operation = method.slice(method.indexOf('.') + 1);
    const projectId = area === 'documents' ? undefined : context.projectId;
    if (['write', 'rm', 'delete', 'mkdir', 'rename'].includes(operation)) {
      if (
        area === 'documents' &&
        !resolveSecurityPolicy(await this.store.readConfig()).allowFileEdits
      )
        throw new Error('File edits are disabled by the security policy');
      if (area === 'workspace' && !(await this.workspaceWriteAllowed(context.projectId)).ok)
        throw new Error('Workspace writes are disabled for this project');
    }
    check();
    const pathKey = area === 'documents' ? 'name' : 'path';
    if (operation === 'read') {
      const content = await this.store.readFile(area, projectId, text(pathKey));
      if (content === null) throw new Error(`File not found: ${text(pathKey)}`);
      return content;
    }
    if (operation === 'write')
      return this.store.writeFile(area, projectId, text(pathKey), text('content'));
    if (operation === 'rm' || operation === 'delete')
      return this.store.deleteFile(area, projectId, text(pathKey));
    if (operation === 'mkdir') return this.store.makeFolder(area, projectId, text(pathKey));
    if (operation === 'rename')
      return this.store.renameFile(area, projectId, text('from'), text('to'));
    if (operation === 'list' || operation === 'listAll') {
      const prefix =
        area === 'documents' || operation === 'listAll'
          ? ''
          : text(area === 'artifacts' ? 'prefix' : 'path', true);
      const { entries, truncated } = await this.store.listFiles(
        area,
        projectId,
        prefix,
        operation === 'listAll' || p.recursive === true,
        { withStats: true },
      );
      if (truncated) throw new Error('File listing exceeded its limit; narrow the folder');
      if (operation === 'listAll')
        return entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
      return Promise.all(
        entries
          .filter((entry) => area === 'workspace' || !entry.isDirectory)
          .map(async (entry) => ({
            ...(area === 'workspace'
              ? { name: entry.name, isDirectory: entry.isDirectory }
              : area === 'artifacts'
                ? { path: entry.path }
                : { name: entry.path }),
            size: entry.isDirectory
              ? 0
              : ((await this.store.statFile(area, projectId, entry.path))?.size ?? 0),
            modified: new Date(entry.mtimeMs ?? 0).toISOString(),
          })),
      );
    }
    if (operation === 'stat') {
      const path = validatePortablePath(text(pathKey));
      const slash = path.lastIndexOf('/');
      const { entries } = await this.store.listFiles(
        area,
        projectId,
        slash < 0 ? '' : path.slice(0, slash),
        false,
        { withStats: true },
      );
      const entry = entries.find((entry) => entry.path === path);
      if (!entry) throw new Error(`File not found: ${path}`);
      return {
        size: entry.isDirectory
          ? 0
          : ((await this.store.statFile(area, projectId, path))?.size ?? 0),
        modified: new Date(entry.mtimeMs ?? 0).toISOString(),
        isDirectory: entry.isDirectory,
        isFile: !entry.isDirectory,
      };
    }
    throw new Error(`SDK method "${method}" is unavailable on this device`);
  };
}
