import type { Poppetje } from '../poppetje/schema.js';
import type { AnswerQuestionRequest, AskQuestionRequest } from '../schemas/api.js';
import type {
  CreateProjectRequest,
  GezelConfig,
  MemorySearchRequest,
  ProjectSearchRequest,
  SearchDocumentsRequest,
  UnifiedSearchRequest,
  UpdateProjectRequest,
} from '../schemas/api.js';
import type { GezelFrontmatter, GezelSummary } from '../schemas/gezel.js';
import { ProjectSchema } from '../schemas/project.js';
import type {
  CreatePromptDraftRequest,
  DuplicatePromptDraftRequest,
  PatchPromptDraftRequest,
} from '../schemas/prompt-draft.js';
import type { ScriptRun } from '../schemas/script.js';
import type { ChatSession } from '../schemas/session.js';
import type { RestoreConfirm } from '../schemas/storage.js';
import { isSharedLibraryProject } from '../shared-project.js';
import * as backup from './backup.js';
import { promptDraftFiles, promptDraftHost } from './drafts-portable.js';
import * as drafts from './drafts.js';
import * as gezels from './gezels.js';
import { ensureLayout } from './layout.js';
import * as memories from './memories.js';
import * as files from './project-files.js';
import * as projects from './projects.js';
import * as questions from './questions.js';
import { PortableRepository, type PortableStoreOptions } from './repository.js';
import * as scriptRuns from './script-runs.js';
import * as scriptSources from './script-sources.js';
import * as search from './search.js';
import * as sessions from './sessions.js';
import * as taskEditing from './task-editing.js';
import * as tasks from './tasks.js';

/** Shared product persistence. Hosts supply confined, atomic file operations. */
export class PortableStore {
  private readonly repo: PortableRepository;
  constructor(options: PortableStoreOptions) {
    this.repo = new PortableRepository(options);
  }
  get version(): string {
    return this.repo.version;
  }
  private run<T>(operation: (repo: PortableRepository) => Promise<T>): Promise<T> {
    return this.repo.run(() => operation(this.repo));
  }
  ensureLayout() {
    return this.run(ensureLayout);
  }
  readConfig() {
    return this.run(projects.readConfig);
  }
  listQuestions(filter: questions.PortableQuestionFilter = {}) {
    return this.run((repo) => questions.listQuestions(repo, filter));
  }
  getQuestion(id: string) {
    return this.run((repo) => questions.getQuestion(repo, id));
  }
  askQuestion(input: AskQuestionRequest) {
    return this.run((repo) => questions.askQuestion(repo, input));
  }
  answerQuestion(id: string, input: AnswerQuestionRequest, continuation?: ChatSession) {
    return this.run((repo) => questions.answerQuestion(repo, id, input, continuation));
  }
  readDocumentReference(path: string) {
    return this.run((repo) => files.readDocumentReference(repo, path));
  }
  search(input: UnifiedSearchRequest) {
    return this.run((repo) => search.search(repo, input));
  }
  searchProject(projectId: string, input: ProjectSearchRequest) {
    return this.run((repo) => search.searchProject(repo, projectId, input));
  }
  searchDocuments(input: SearchDocumentsRequest) {
    return this.run((repo) => search.searchDocuments(repo, input));
  }
  listMemoryDays(scope: memories.PortableMemoryScope, id: string) {
    return this.run((repo) => memories.listMemoryDays(repo, scope, id));
  }
  readMemoryDay(scope: memories.PortableMemoryScope, id: string, day: string) {
    return this.run((repo) => memories.readMemoryDay(repo, scope, id, day));
  }
  updateMemoryDay(scope: memories.PortableMemoryScope, id: string, day: string, content: string) {
    return this.run((repo) => memories.updateMemoryDay(repo, scope, id, day, content));
  }
  readMemorySummary(scope: memories.PortableMemoryScope, id: string) {
    return this.run((repo) => memories.readMemorySummary(repo, scope, id));
  }
  readMemoryLessons(id: string) {
    return this.run((repo) => memories.readMemoryLessons(repo, id));
  }
  writeMemoryLessons(id: string, content: string) {
    return this.run((repo) => memories.writeMemoryLessons(repo, id, content));
  }
  saveMemory(input: memories.PortableSaveMemory) {
    return this.run((repo) => memories.saveMemory(repo, input));
  }
  searchMemories(input: MemorySearchRequest) {
    return this.run((repo) => memories.searchMemories(repo, input));
  }
  searchMemoryScope(scope: memories.PortableMemoryScope, id: string, query: string) {
    return this.run((repo) => memories.searchMemoryScope(repo, scope, id, query));
  }
  planBackup(options: backup.PortableBackupOptions = {}) {
    return this.run((repo) => backup.planBackup(repo, options));
  }
  exportBackup(options: backup.PortableBackupOptions = {}) {
    return this.run((repo) => backup.exportBackup(repo, options));
  }
  scanRestore(bytes: Uint8Array) {
    return this.run((repo) => backup.scanRestore(repo, bytes));
  }
  confirmRestore(id: string, input: RestoreConfirm) {
    return this.run((repo) => backup.confirmRestore(repo, id, input));
  }
  cancelRestore(id: string) {
    return this.run((repo) => backup.cancelRestore(repo, id));
  }
  writeConfig(patch: Partial<{ [K in keyof GezelConfig]: GezelConfig[K] | null }>) {
    return this.run((repo) => projects.writeConfig(repo, patch));
  }
  sharedProjectId() {
    return this.run(projects.sharedProjectId);
  }
  listProjects() {
    return this.run(projects.listProjects);
  }
  getProject(id: string) {
    return this.run((repo) => projects.getProject(repo, id));
  }
  createProject(input: CreateProjectRequest) {
    return this.run((repo) => projects.createProject(repo, input));
  }
  updateProject(id: string, patch: UpdateProjectRequest) {
    return this.run((repo) => projects.updateProject(repo, id, patch));
  }
  addGezelToProject(id: string, gezelId: string) {
    return this.run((repo) => projects.setRoster(repo, id, gezelId, true));
  }
  removeGezelFromProject(id: string, gezelId: string) {
    return this.run((repo) => projects.setRoster(repo, id, gezelId, false));
  }
  deleteProject(id: string, options: { removeWorkspace?: boolean } = {}) {
    return this.run(async (repo) => {
      const project = await projects.requireProject(repo, id);
      if (id === 'default' || isSharedLibraryProject(project))
        throw new Error('The default project and shared library cannot be deleted');
      const writes = new Map<string, Uint8Array>();
      for (const other of await projects.listProjects(repo))
        if (other.id !== id && other.linkedProjectIds?.includes(id)) {
          writes.set(
            `${projects.projectRoot(other.id)}/project.json`,
            repo.json({
              ...other,
              linkedProjectIds: other.linkedProjectIds.filter((value) => value !== id),
              updatedAt: repo.now(),
            }),
          );
        }
      for (const summary of await sessions.listSessions(repo, { projectId: id })) {
        const session = await sessions.getSession(repo, summary.gezelId, summary.id);
        if (session)
          writes.set(
            sessions.sessionPath(session.gezelId, session.id),
            repo.json({ ...session, archived: true }),
          );
      }
      await repo.transactions.commit(writes, [
        options.removeWorkspace
          ? projects.projectRoot(id)
          : `${projects.projectRoot(id)}/project.json`,
      ]);
      return {
        name: project.name,
        removedWorkspace: !!options.removeWorkspace,
        workspaceSource: 'internal' as const,
      };
    });
  }
  listGezels() {
    return this.run(gezels.listGezels);
  }
  getGezel(id: string) {
    return this.run((repo) => gezels.getGezel(repo, id));
  }
  getGezelPoppetje(id: string) {
    return this.run((repo) => gezels.getGezelPoppetje(repo, id));
  }
  setGezelPoppetje(id: string, poppetje: Poppetje) {
    return this.run((repo) => gezels.setGezelPoppetje(repo, id, poppetje));
  }
  rerollGezelPoppetje(id: string, options: { seed?: number } = {}) {
    return this.run((repo) => gezels.rerollGezelPoppetje(repo, id, options));
  }
  createGezel(input: gezels.PortableCreateGezelInput) {
    return this.run((repo) => gezels.createGezel(repo, input));
  }
  updateGezelAbout(id: string, about: string) {
    return this.run((repo) => gezels.updateGezelAbout(repo, id, about));
  }
  updateGezelMarkdown(id: string, source: string) {
    return this.run((repo) => gezels.updateGezelMarkdown(repo, id, source));
  }
  updateGezelSettings(
    id: string,
    patch: Partial<{ [K in keyof GezelFrontmatter]: GezelFrontmatter[K] | null }>,
  ) {
    return this.run((repo) => gezels.updateGezelSettings(repo, id, patch));
  }
  deleteGezel(id: string) {
    return this.run(async (repo) => {
      const gezel = await gezels.requireGezel(repo, id);
      const config = await projects.readConfig(repo);
      if (config.meesterGezelId === id)
        throw new Error('Choose another Meester in Settings before removing this gezel');
      const writes = new Map<string, Uint8Array>();
      for (const project of await projects.listProjects(repo))
        if (project.voormanGezelId === id || project.gezelIds?.includes(id)) {
          const next = {
            ...project,
            gezelIds: project.gezelIds?.filter((value) => value !== id),
            updatedAt: repo.now(),
          };
          if (next.voormanGezelId === id) delete next.voormanGezelId;
          writes.set(
            `${projects.projectRoot(project.id)}/project.json`,
            repo.json(ProjectSchema.parse(next)),
          );
        }
      for (const key of ['klerkGezelId', 'boekwachterGezelId', 'keurmeesterGezelId'] as const)
        if (config[key] === id) delete config[key];
      writes.set('config.json', repo.json(config));
      await repo.transactions.commit(writes, [gezels.gezelRoot(id)]);
      return { id, name: gezel.name };
    });
  }
  getProjectGezels(projectId: string) {
    return this.run(async (repo) => {
      const project = await projects.requireProject(repo, projectId);
      return (await gezels.listGezels(repo)).filter(
        (gezel) => project.gezelIds?.includes(gezel.id) || project.voormanGezelId === gezel.id,
      );
    });
  }
  /** This host exposes team gezels. Creating workspace-local @project gezels is not supported. */
  listProjectLocalGezels(projectId: string): Promise<GezelSummary[]> {
    return this.run(async (repo) => {
      await projects.requireProject(repo, projectId);
      return [];
    });
  }
  getProjectContext(projectId: string, gezelId: string) {
    return this.run(async (repo) => {
      const project = await projects.requireProject(repo, projectId);
      const gezel = await gezels.requireGezel(repo, gezelId);
      const crew = (await gezels.listGezels(repo)).filter(
        (member) => project.gezelIds?.includes(member.id) || member.id === project.voormanGezelId,
      );
      return { project, gezel, crew, sharedProjectId: await projects.sharedProjectId(repo) };
    });
  }
  createSession(input: sessions.CreatePortableSession) {
    return this.run((repo) => sessions.createSession(repo, input));
  }
  getSession(gezelId: string, id: string) {
    return this.run((repo) => sessions.getSession(repo, gezelId, id));
  }
  writeSession(session: ChatSession, options: { sentDraftId?: string } = {}) {
    return this.run((repo) => sessions.writeSession(repo, session, options));
  }
  listSessions(options: { gezelId?: string; projectId?: string } = {}) {
    return this.run((repo) => sessions.listSessions(repo, options));
  }
  mutateSession(
    gezelId: string,
    id: string,
    mutate: (session: ChatSession) => void | Promise<void>,
  ): Promise<boolean> {
    return this.run(async (repo) => {
      const session = await sessions.getSession(repo, gezelId, id);
      if (!session) return false;
      await mutate(session);
      await sessions.writeSession(repo, session);
      return true;
    });
  }
  deleteSession(gezelId: string, id: string) {
    return this.run((repo) =>
      repo.transactions.commit(new Map(), [sessions.sessionPath(gezelId, id)]),
    );
  }
  listFiles(
    area: files.PortableFileArea,
    projectId: string | undefined,
    subpath = '',
    recursive = false,
    options: files.PortableListOptions = {},
  ) {
    return this.run((repo) => files.listFiles(repo, area, projectId, subpath, recursive, options));
  }
  readFile(area: files.PortableFileArea, projectId: string | undefined, path: string) {
    return this.run((repo) => files.readFile(repo, area, projectId, path));
  }
  writeFile(
    area: files.PortableFileArea,
    projectId: string | undefined,
    path: string,
    content: string,
  ) {
    return this.run((repo) => files.writeFile(repo, area, projectId, path, content));
  }
  /** Keep the read, pure edit, and guarded write in one serialized store operation. */
  editWorkspaceFile(projectId: string, path: string, edit: (content: string | null) => string) {
    return this.run(async (repo) => {
      const before = await files.readFile(repo, 'workspace', projectId, path);
      const after = edit(before);
      await files.writeFile(repo, 'workspace', projectId, path, after);
      return { path, bytes: new TextEncoder().encode(after).byteLength };
    });
  }
  readFileBytes(area: files.PortableFileArea, projectId: string | undefined, path: string) {
    return this.run((repo) => files.readFileBytes(repo, area, projectId, path));
  }
  writeFileBytes(
    area: files.PortableFileArea,
    projectId: string | undefined,
    path: string,
    bytes: Uint8Array,
    options: { createOnly?: boolean } = {},
  ) {
    return this.run((repo) => files.writeFileBytes(repo, area, projectId, path, bytes, options));
  }
  makeFolder(area: files.PortableFileArea, projectId: string | undefined, path: string) {
    return this.run((repo) => files.makeFolder(repo, area, projectId, path));
  }
  deleteFile(area: files.PortableFileArea, projectId: string | undefined, path: string) {
    return this.run((repo) => files.deleteFile(repo, area, projectId, path));
  }
  renameFile(
    area: files.PortableFileArea,
    projectId: string | undefined,
    from: string,
    to: string,
  ) {
    return this.run((repo) => files.renameFile(repo, area, projectId, from, to));
  }
  private draftPort(repo: PortableRepository, projectId: string) {
    return { files: promptDraftFiles(repo, projectId), host: promptDraftHost(repo) };
  }
  listPromptDrafts(projectId: string, options: drafts.PromptDraftListFilter = {}) {
    return this.run(async (repo) => {
      await projects.requireProject(repo, projectId);
      const { files, host } = this.draftPort(repo, projectId);
      return drafts.listPromptDrafts(files, host, projectId, options);
    });
  }
  getPromptDraft(projectId: string, id: string) {
    return this.run(async (repo) => {
      await projects.requireProject(repo, projectId);
      const { files, host } = this.draftPort(repo, projectId);
      return drafts.getPromptDraft(files, host, projectId, id);
    });
  }
  createPromptDraft(projectId: string, input: CreatePromptDraftRequest) {
    return this.run((repo) => {
      const { files, host } = this.draftPort(repo, projectId);
      return drafts.createPromptDraft(files, host, projectId, input);
    });
  }
  writePromptDraftContent(projectId: string, id: string, content: string) {
    return this.run(async (repo) => {
      const { files, host } = this.draftPort(repo, projectId);
      const { meta: _meta, ...result } = await drafts.writePromptDraftContent(
        files,
        host,
        projectId,
        id,
        content,
      );
      return result;
    });
  }
  patchPromptDraft(projectId: string, id: string, patch: PatchPromptDraftRequest) {
    return this.run((repo) => {
      const { files, host } = this.draftPort(repo, projectId);
      return drafts.patchPromptDraft(files, host, projectId, id, patch);
    });
  }
  deletePromptDraft(projectId: string, id: string) {
    return this.run(async (repo) => {
      const { files } = this.draftPort(repo, projectId);
      return (await drafts.deletePromptDraft(files, projectId, id)).deleted;
    });
  }
  duplicatePromptDraft(projectId: string, id: string, options: DuplicatePromptDraftRequest = {}) {
    return this.run((repo) => {
      const { files, host } = this.draftPort(repo, projectId);
      return drafts.duplicatePromptDraft(files, host, projectId, id, options);
    });
  }
  markPromptDraftSent(projectId: string, id: string, sessionId: string, messageAt?: string) {
    return this.run((repo) => {
      const { files, host } = this.draftPort(repo, projectId);
      return drafts.markPromptDraftSent(files, host, projectId, id, { sessionId, messageAt });
    });
  }
  writeScriptRun(run: ScriptRun) {
    return this.run((repo) => scriptRuns.writeScriptRun(repo, run));
  }
  getScriptRun(projectId: string, id: string) {
    return this.run((repo) => scriptRuns.getScriptRun(repo, projectId, id));
  }
  recoverScriptRuns() {
    return this.run(scriptRuns.recoverScriptRuns);
  }
  readScriptSource(scope: scriptSources.EditableScriptScope, name: string) {
    return this.run((repo) => scriptSources.readScriptSource(repo, scope, name));
  }
  listScriptSources(scope: scriptSources.EditableScriptScope) {
    return this.run((repo) => scriptSources.listScriptSources(repo, scope));
  }
  saveScriptSource(
    scope: scriptSources.EditableScriptScope,
    input: Parameters<typeof scriptSources.saveScriptSource>[2],
  ) {
    return this.run((repo) => scriptSources.saveScriptSource(repo, scope, input));
  }
  deleteScriptSource(scope: scriptSources.EditableScriptScope, name: string) {
    return this.run((repo) => scriptSources.deleteScriptSource(repo, scope, name));
  }

  listTasks(filter: tasks.PortableTaskFilter = {}) {
    return this.run((repo) => tasks.listTasks(repo, filter));
  }
  getTask(ref: string) {
    return this.run((repo) => tasks.getTask(repo, ref));
  }
  createTask(
    projectId: string,
    input: Parameters<typeof tasks.createTask>[2],
    resolved?: Parameters<typeof tasks.createTask>[3],
  ) {
    return this.run((repo) => tasks.createTask(repo, projectId, input, resolved));
  }
  updateTask(
    ref: string,
    patch: Parameters<typeof tasks.updateTask>[2],
    expectedActiveStepId?: string,
  ) {
    return this.run((repo) => tasks.updateTask(repo, ref, patch, expectedActiveStepId));
  }
  setTaskStatus(ref: string, status: Parameters<typeof tasks.setTaskStatus>[2]) {
    return this.run((repo) => tasks.setTaskStatus(repo, ref, status));
  }
  pauseTaskIfActive(ref: string) {
    return this.run((repo) => tasks.pauseTaskIfActive(repo, ref));
  }
  completeTaskStep(ref: string, stepId: string, options: tasks.PortableTaskCompletion = {}) {
    return this.run((repo) => tasks.completeTaskStep(repo, ref, stepId, options));
  }
  resolveTaskStepRole(ref: string, stepId: string, gezelId: string) {
    return this.run((repo) => tasks.resolveTaskStepRole(repo, ref, stepId, gezelId));
  }
  beginTaskRun(ref: string) {
    return this.run((repo) => tasks.beginTaskRun(repo, ref));
  }
  finishTaskRun(ref: string, runId: string, error?: string) {
    return this.run((repo) => tasks.finishTaskRun(repo, ref, runId, error));
  }
  recoverTasks() {
    return this.run(tasks.recoverTasks);
  }
  listTaskNotes(ref: string) {
    return this.run((repo) => tasks.listTaskNotes(repo, ref));
  }
  appendTaskNote(
    ref: string,
    text: string,
    stepId?: string,
    actorGezelId?: string,
    expectedActiveStepId?: string,
  ) {
    return this.run((repo) =>
      tasks.appendTaskNote(repo, ref, text, stepId, actorGezelId, expectedActiveStepId),
    );
  }
  startProject(input: tasks.PortableStartProject) {
    return this.run((repo) => tasks.startProject(repo, input));
  }

  statFile(area: files.PortableFileArea, projectId: string | undefined, path: string) {
    return this.run((repo) => files.statFile(repo, area, projectId, path));
  }
  updateTaskStep(
    ref: string,
    stepId: string,
    patch: Parameters<typeof taskEditing.updateTaskStep>[3],
  ) {
    return this.run((repo) => taskEditing.updateTaskStep(repo, ref, stepId, patch));
  }
  addTaskStep(ref: string, input: unknown) {
    return this.run((repo) => taskEditing.addTaskStep(repo, ref, input));
  }
  removeTaskStep(ref: string, stepId: string) {
    return this.run((repo) => taskEditing.removeTaskStep(repo, ref, stepId));
  }
  reorderTaskSteps(ref: string, order: string[]) {
    return this.run((repo) => taskEditing.reorderTaskSteps(repo, ref, order));
  }
  updateTaskCraftbook(ref: string, patch: Parameters<typeof taskEditing.updateTaskCraftbook>[2]) {
    return this.run((repo) => taskEditing.updateTaskCraftbook(repo, ref, patch));
  }
  activateTaskStep(ref: string, stepId: string) {
    return this.run((repo) => taskEditing.activateTaskStep(repo, ref, stepId));
  }
  updateTaskNote(ref: string, noteId: string, input: unknown) {
    return this.run((repo) => taskEditing.editTaskNote(repo, ref, noteId, input));
  }
  deleteTaskNote(ref: string, noteId: string) {
    return this.run((repo) => taskEditing.editTaskNote(repo, ref, noteId));
  }

  getTaskLifecycle(ref: string) {
    return this.run((repo) => tasks.getTaskLifecycle(repo, ref));
  }
  beginTaskHook(
    ref: string,
    stepId: string,
    moment: 'onEnter' | 'onExit',
    index: number,
    script: Parameters<typeof tasks.beginTaskHook>[5],
    retryInterrupted = false,
  ) {
    return this.run((repo) =>
      tasks.beginTaskHook(repo, ref, stepId, moment, index, script, retryInterrupted),
    );
  }
  finishTaskHook(
    ref: string,
    activationId: string,
    id: string,
    result: Parameters<typeof tasks.finishTaskHook>[4],
  ) {
    return this.run((repo) => tasks.finishTaskHook(repo, ref, activationId, id, result));
  }
}
