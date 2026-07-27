import { type GateCheck, type Task, completionGate } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { evaluateMockExpectations, mockMcpToolsetId } from '../mock/mock-server.ts';
import {
  type MissingDeliverableNearMiss,
  postMissingDeliverableFeedback,
  postSniffFeedback,
} from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { evaluateCraftbookGateChecks } from './gates.ts';
import { findProjectIdByName as findProjectId, workspaceFromClient } from './shared.ts';
import type {
  CraftbookEvalDeliverable,
  CraftbookEvalGateCheck,
  CraftbookEvalSpec,
} from './types.ts';

const WORKSPACE_EVAL_TOOLSET_IDS = [
  'builtin.workspace-fs-read',
  'builtin.workspace-fs-write',
] as const;

function workspaceFixturePaths(spec: CraftbookEvalSpec): string[] {
  return (spec.setup?.files ?? [])
    .filter((file) => file.surface !== 'artifact')
    .map((file) => file.path);
}

function deliverablePaths(spec: CraftbookEvalSpec): string[] {
  return (spec.success.deliverables ?? []).map((deliverable) => deliverable.path);
}

function directWorkerNeedsWorkspaceToolsets(spec: CraftbookEvalSpec): boolean {
  return workspaceFixturePaths(spec).length > 0 || deliverablePaths(spec).length > 0;
}

const RASTER_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const RASTER_IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

/**
 * A book whose deterministic success needs raster image files can only pass
 * when the worker can call `render_image` / `generate_image`. The workspace
 * toolset install above becomes a per-gezel override that REPLACES the
 * worker's role kit, so without an explicit install the `images` group is
 * absent from the session surface entirely — wild-caught in the
 * cbmx-20260720 sweep: character-sheet / character-turnaround /
 * tileset-batch workers wrote .json stubs because `render_image` never
 * reached the model's function schema. Same precedent as the cli-shim
 * `code-execution` install below.
 */
function directWorkerNeedsImageToolset(spec: CraftbookEvalSpec): boolean {
  const checks: CraftbookEvalGateCheck[] = [
    ...(spec.success.checks ?? []),
    ...(spec.success.deliverables ?? []).flatMap((deliverable) => deliverable.checks ?? []),
  ];
  const fileCountNeedsRaster = checks.some(
    (check) =>
      check.kind === 'fileCount' &&
      check.ext.some((ext) => RASTER_IMAGE_EXTS.has(ext.toLowerCase())),
  );
  const deliverableIsRaster = (spec.success.deliverables ?? []).some((deliverable) =>
    RASTER_IMAGE_EXT_RE.test(deliverable.path),
  );
  return fileCountNeedsRaster || deliverableIsRaster;
}

interface ToolCallLike {
  name?: string;
  success?: boolean;
  path?: string;
  argsFull?: string;
  argsSummary?: string;
}

interface ChatMessageLike {
  toolCalls?: ToolCallLike[];
}

interface ChatSessionLike {
  id: string;
  messages?: ChatMessageLike[];
}

function craftbookEvalProjectAbout(spec: CraftbookEvalSpec): string {
  const seededPaths = workspaceFixturePaths(spec);
  const outputs = deliverablePaths(spec);
  const lines = [
    '### Eval harness rules',
    'This is a self-contained craftbook eval project. Treat all paths as project workspace paths.',
    seededPaths.length > 0
      ? `Seeded workspace inputs: ${seededPaths.map((path) => `\`${path}\``).join(', ')}. Read them with the workspace \`readFile\` tool, not artifact/document/library tools.`
      : null,
    outputs.length > 0
      ? `Required workspace deliverable${outputs.length === 1 ? '' : 's'}: ${outputs.map((path) => `\`${path}\``).join(', ')}. Chat summaries, artifacts, plans, and task notes do not satisfy file deliverables.`
      : null,
  ].filter((line): line is string => !!line);
  return [spec.setup?.about?.trim(), lines.join('\n\n')].filter(Boolean).join('\n\n');
}

function craftbookEvalMissionObjectives(spec: CraftbookEvalSpec): string {
  const outputs = deliverablePaths(spec);
  const harnessMission = spec.success.taskGraph
    ? [
        'Use the requested craftbook/template when available, then produce the required structured task graph in this project.',
        'The eval output is the draft task graph itself, not a workspace artifact. Do not activate the draft or build the planned deliverable unless the prompt explicitly asks for execution.',
        'If invoking the craftbook creates an authoring task, keep working on that authoring task until the draft has the required outcomes, gated build steps, and verification step.',
      ]
    : [
        'Use the requested craftbook/template when available, then execute the work in this project until the deterministic eval outputs exist.',
        outputs.length > 0
          ? `Write the final file${outputs.length === 1 ? '' : 's'} at the exact workspace-root-relative path${outputs.length === 1 ? '' : 's'}: ${outputs.map((path) => `\`${path}\``).join(', ')}.`
          : null,
        'If invoking the craftbook creates a task, do not stop after creating or assigning it; carry out the active step or hand it to an appropriate gezel with an explicit expected file deliverable.',
      ];
  return [spec.setup?.missionObjectives?.trim(), ...harnessMission].filter(Boolean).join('\n');
}

function craftbookEvalKickoffPrompt(spec: CraftbookEvalSpec): string {
  const seededPaths = workspaceFixturePaths(spec);
  const outputs = deliverablePaths(spec);
  const readCalls = seededPaths.map((path) => `readFile({ path: "${path}" })`);
  const harnessLines = [
    '[craftbook eval harness]',
    'This project is self-contained; all referenced source paths are workspace-root-relative.',
    seededPaths.length > 0
      ? `Before writing any deliverable, read every seeded input with workspace file tools: ${readCalls.map((call) => `\`${call}\``).join(', ')}. Do not use \`read_artifact\`, \`read_document\`, or library tools for these workspace files.`
      : 'Use workspace file tools for any project files you need to inspect.',
    outputs.length > 0
      ? `The eval only passes when the actual workspace file${outputs.length === 1 ? '' : 's'} exist${outputs.length === 1 ? 's' : ''}: ${outputs.map((path) => `\`${path}\``).join(', ')}. Write with \`writeFile\` using the exact path, not \`workspace/<path>\`.`
      : null,
    spec.success.taskGraph
      ? 'Use the requested craftbook/template by invoking it when needed, but keep the work task-native: create and complete the authoring flow for the draft task graph. Do not activate the draft and do not build the planned workspace artifact.'
      : 'Use the requested craftbook/template as guidance or by invoking it, but do not stop after creating a task. Execute the active craftbook step(s) now until the required output exists.',
    '',
    spec.prompt,
  ].filter((line): line is string => !!line);
  return harnessLines.join('\n');
}

function craftbookMissingDeliverableRepairDirective(spec: CraftbookEvalSpec): string {
  const seededPaths = workspaceFixturePaths(spec);
  const lines = [
    '[craftbook eval repair]',
    seededPaths.length > 0
      ? `The source fixture is already in this project workspace: ${seededPaths.map((path) => `\`${path}\``).join(', ')}. If you need source content, call workspace \`readFile\` on that exact path; do not ask the user for it and do not use artifact/document/library tools.`
      : null,
    'Final deliverables must be written with the workspace `writeFile` tool. Do not call `write_artifact` or `write_document` for final deliverables.',
    'If you invoked a craftbook task, do not wait for another assignee before producing the eval deliverable. Execute the active step yourself or make an explicit file-deliverable handoff, then write the required file.',
  ].filter((line): line is string => !!line);
  return lines.join('\n');
}

function craftbookSourceReadRepairDirective(missingPaths: readonly string[]): string {
  const calls = missingPaths.map((path) => `readFile({ path: "${path}" })`);
  return [
    'SOURCE_READ_REQUIRED: the output is being repaired before the seeded input files have been opened.',
    `Your next tool call${calls.length === 1 ? '' : 's'} MUST read the missing source file${calls.length === 1 ? '' : 's'}: ${calls.map((call) => `\`${call}\``).join(', ')}.`,
    'Do not write or patch the deliverable again until those source files have been read in this project workspace.',
    'After reading them, rewrite the deliverable using only facts present in those files and the locked schema.',
  ].join(' ');
}

function toolCallReferencesPath(call: ToolCallLike, path: string): boolean {
  if (call.path === path) return true;
  const argText = [call.argsFull, call.argsSummary].filter(Boolean).join('\n');
  if (!argText) return false;
  const quoted = JSON.stringify(path);
  return (
    argText.includes(`path: ${path}`) ||
    argText.includes(`path: ${quoted}`) ||
    argText.includes(`"path":${quoted}`) ||
    argText.includes(`"path": ${quoted}`) ||
    argText.includes(path)
  );
}

function sessionReadPaths(session: ChatSessionLike, seededPaths: readonly string[]): Set<string> {
  const read = new Set<string>();
  for (const message of session.messages ?? []) {
    for (const call of message.toolCalls ?? []) {
      if (call.name !== 'readFile' || call.success === false) continue;
      for (const path of seededPaths) {
        if (toolCallReferencesPath(call, path)) read.add(path);
      }
    }
  }
  return read;
}

async function missingSeededReads(
  client: GezelClient,
  projectId: string,
  spec: CraftbookEvalSpec,
): Promise<string[]> {
  const seededPaths = workspaceFixturePaths(spec);
  if (seededPaths.length === 0) return [];
  const maybeClient = client as unknown as {
    listChatSessions?: (filter?: { projectId?: string }) => Promise<{
      sessions: ChatSessionLike[];
    }>;
    getChatSession?: (sessionId: string) => Promise<ChatSessionLike>;
  };
  if (
    typeof maybeClient.listChatSessions !== 'function' ||
    typeof maybeClient.getChatSession !== 'function'
  ) {
    return [];
  }
  try {
    const { sessions } = await maybeClient.listChatSessions({ projectId });
    const read = new Set<string>();
    for (const listed of sessions ?? []) {
      const session = listed.messages ? listed : await maybeClient.getChatSession(listed.id);
      for (const path of sessionReadPaths(session, seededPaths)) read.add(path);
    }
    return seededPaths.filter((path) => !read.has(path));
  } catch {
    return [];
  }
}

async function ensureProject(ctx: EvalContext, spec: CraftbookEvalSpec): Promise<string | null> {
  if (!spec.setup) return null;
  const existing = await findProjectId(ctx.client, spec.setup.projectName);
  if (existing) return existing;
  const created = await ctx.client.createProject({
    name: spec.setup.projectName,
    about: craftbookEvalProjectAbout(spec),
    missionObjectives: craftbookEvalMissionObjectives(spec),
  });
  ctx.log(`[craftbook:${spec.craftbookId}] created project ${created.id}`);
  return created.id;
}

async function writeFixtureFiles(
  ctx: EvalContext,
  projectId: string,
  spec: CraftbookEvalSpec,
): Promise<void> {
  for (const file of spec.setup?.files ?? []) {
    // Fixture text may reference {{mock:*}} placeholders (ports are
    // per-trial); substitute when the live runtime is present.
    const content = ctx.mocks ? ctx.mocks.substitute(file.content) : file.content;
    if (file.surface === 'artifact') {
      await ctx.client.writeProjectArtifact(projectId, file.path, content);
    } else {
      await ctx.client.writeProjectWorkspaceFile(projectId, { path: file.path, content });
    }
  }
}

/**
 * Live mock-service setup for a mock-enabled trial project: grant the
 * `mock.<id>` credentials with each service's exact loopback origin,
 * seed the `mocks/services.md|json` discovery docs (live truth replacing
 * the old documentation-only simulator fixtures), and install each `cli`
 * shim as a provenance-trusted project script (`@gezel-craftbook-test`
 * header + catalog-shipped bytes — the byte-match is what lets the
 * sandbox child start on platforms with no OS network boundary).
 */
async function setupMockServices(
  ctx: EvalContext,
  projectId: string,
  spec: CraftbookEvalSpec,
): Promise<void> {
  const mocks = ctx.mocks;
  if (!mocks) return;
  const grants = mocks.projectGrants();
  if (grants.grantedCredentials.length > 0) {
    await ctx.client.updateProject(projectId, grants);
    ctx.log(
      `[craftbook:${spec.craftbookId}] granted ${grants.grantedCredentials.join(', ')} on ${projectId}`,
    );
  }
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: 'mocks/services.md',
    content: mocks.servicesMarkdown(),
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: 'mocks/services.json',
    content: mocks.servicesJson(),
  });
  for (const mock of spec.mocks ?? []) {
    if (mock.kind !== 'cli') continue;
    const name = mock.shim.path.replace(/^scripts\//, '').replace(/\.(ts|mjs|js)$/, '');
    const header = `// @gezel-craftbook-test: ${spec.craftbookId}@${spec.testSpecVersion ?? '1.0.0'}`;
    await ctx.client.saveProjectScriptSource(projectId, {
      name,
      source: `${header}\n${mock.shim.content}`,
    });
    ctx.log(`[craftbook:${spec.craftbookId}] installed provenance-trusted shim script "${name}"`);
  }
}

/**
 * Install the local-catalog `mock-mcp-<id>` toolset for every `mcp` mock
 * onto the gezel that will do the work. The runner already wrote the
 * manifests into the trial home's local catalog root before the daemon
 * spawned, so this rides the ordinary catalog-install rail — the gezel's
 * next session build bridges the fake MCP over Streamable HTTP and its
 * tools land on the normal roster.
 */
async function installMockMcpToolsets(
  ctx: EvalContext,
  spec: CraftbookEvalSpec,
  gezelId: string,
): Promise<void> {
  for (const mock of spec.mocks ?? []) {
    if (mock.kind !== 'mcp') continue;
    const toolsetId = mockMcpToolsetId(mock.id);
    await ctx.client.installToolset(toolsetId, {
      scope: { kind: 'gezel', gezelId },
    });
    ctx.log(`[craftbook:${spec.craftbookId}] installed ${toolsetId} toolset for ${gezelId}`);
  }
}

async function ensureWorker(ctx: EvalContext, spec: CraftbookEvalSpec): Promise<string | null> {
  const worker = spec.setup?.worker;
  if (!worker) return null;

  try {
    const created = await ctx.client.createGezel({
      name: worker.name,
      role: worker.role,
      ...(worker.description ? { description: worker.description } : {}),
      ...(worker.about ? { about: worker.about } : {}),
    });
    ctx.log(`[craftbook:${spec.craftbookId}] created worker "${worker.name}" id=${created.id}`);
    return created.id;
  } catch (err) {
    const { gezels } = await ctx.client.listGezels();
    const existing = gezels.find((gezel) => gezel.name === worker.name);
    if (!existing) throw err;
    ctx.log(`[craftbook:${spec.craftbookId}] reusing worker "${worker.name}" id=${existing.id}`);
    return existing.id;
  }
}

/** `createTask` requires a description of at least 40 chars. */
function craftbookTaskDescription(spec: CraftbookEvalSpec): string {
  const base = (spec.objective ?? '').trim() || spec.title;
  return `${base} Run this craftbook end to end in this project until the deterministic eval deliverables exist.`;
}

/**
 * Run a declarative-fanout book as a real craftbook TASK: create the task
 * from the catalog craftbook (the runtime derives the spawn host from the
 * book's `spawn` block) and dispatch its entry step, so the runtime drives
 * the step chain — scope -> draft (fanout) -> collect -> ... — and spawns
 * one child per item itself. The worker is the task assignee; each step's
 * suggestedRole resolves to a role-matched gezel at activation. This replaces
 * the freehand direct-worker kickoff for spawn books so the craftbook's
 * step/gate/fanout machinery actually executes.
 */
async function dispatchCraftbookTask(
  ctx: EvalContext,
  spec: CraftbookEvalSpec,
  projectId: string,
  workerId: string,
): Promise<void> {
  const task = await ctx.client.createTask(projectId, {
    title: spec.title,
    description: craftbookTaskDescription(spec),
    craftbookId: spec.craftbookId,
    assignee: { kind: 'gezel', gezelId: workerId },
    dispatchEntry: true,
  });
  ctx.log(
    `[craftbook:${spec.craftbookId}] created + dispatched fanout craftbook task ${task.ref} in project ${projectId}`,
  );
}

async function ensureWorkspaceToolsetsForWorker(
  client: GezelClient,
  workerId: string,
): Promise<void> {
  for (const id of WORKSPACE_EVAL_TOOLSET_IDS) {
    await client.installToolset(id, {
      scope: { kind: 'gezel', gezelId: workerId },
    });
  }
}

const TASK_NOTES_WORKSPACE_PATHS = [
  'task-notes.md',
  'task_notes.md',
  'notes/task-notes.md',
  'notes/task_notes.md',
] as const;

async function workspaceTaskNotesText(client: GezelClient, projectId: string): Promise<string[]> {
  const notes: string[] = [];
  for (const path of TASK_NOTES_WORKSPACE_PATHS) {
    try {
      const blob = await client.fetchProjectWorkspaceBlob(projectId, path);
      const text = await blob.text();
      if (text.trim().length > 0) notes.push(text);
    } catch {
      // Missing note aliases are expected while the model is still working.
    }
  }
  return notes;
}

async function artifactNearMiss(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<MissingDeliverableNearMiss | undefined> {
  try {
    const artifact = await client.readProjectArtifact(projectId, filePath);
    if (!artifact.content) return undefined;
    return {
      path: filePath,
      location: `artifacts/${artifact.path || filePath}`,
      bytes: artifact.content.length,
    };
  } catch {
    return undefined;
  }
}

async function documentNearMiss(
  client: GezelClient,
  filePath: string,
): Promise<MissingDeliverableNearMiss | undefined> {
  try {
    const document = await client.readDocument(filePath);
    if (!document.content) return undefined;
    const location =
      document.kind === 'artifact' && document.resolvedFrom
        ? `artifacts/${document.resolvedFrom.relativePath}`
        : document.kind === 'project-document'
          ? `project-documents/${document.path || filePath}`
          : `documents/${document.path || filePath}`;
    return {
      path: filePath,
      location,
      bytes: document.content.length,
    };
  } catch {
    return undefined;
  }
}

async function wrongSurfaceNearMiss(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<MissingDeliverableNearMiss | undefined> {
  return (
    (await documentNearMiss(client, filePath)) ??
    (await artifactNearMiss(client, projectId, filePath))
  );
}

async function taskNotesTextForSpec(
  client: GezelClient,
  projectId: string,
  spec: CraftbookEvalSpec,
): Promise<{ text: string; taskCount: number; matchingCraftbookTaskCount: number }> {
  const listed = await client.listProjectTasks(projectId);
  const taskNotes: string[] = [];
  let matchingCraftbookTaskCount = 0;
  for (const task of listed.tasks) {
    const craftbookMatches = taskMatchesCraftbook(task, spec);
    if (craftbookMatches) matchingCraftbookTaskCount++;
    if (spec.success.taskNotes?.requireCraftbookTask && !craftbookMatches) continue;
    const { notes } = await client.listTaskNotes(task.projectId, task.num);
    for (const note of notes) {
      taskNotes.push(note.text);
    }
  }
  taskNotes.push(...(await workspaceTaskNotesText(client, projectId)));
  return {
    text: taskNotes.join('\n\n'),
    taskCount: listed.tasks.length,
    matchingCraftbookTaskCount,
  };
}

function taskMatchesCraftbook(task: Task, spec: CraftbookEvalSpec): boolean {
  const sourceIds = task.sourceCraftbookIds?.map((source) => source.catalogId) ?? [];
  return task.craftbook.id === spec.craftbookId || sourceIds.includes(spec.craftbookId);
}

function taskSummary(task: Task): string {
  const steps = task.craftbook.steps
    .map((step) => {
      const gate = step.gate ? ' gate' : '';
      const advance = step.advanceWhen ? ` advanceWhen=${step.advanceWhen.file}` : '';
      const terminal = step.terminal ? ' terminal' : '';
      return `- ${step.id}: ${step.name}${gate}${advance}${terminal}`;
    })
    .join('\n');
  const outcomes = (task.outcomes ?? [])
    .map((outcome, index) => `${index + 1}. ${outcome.text}`)
    .join('\n');
  return [
    `Task ${task.ref}: ${task.title}`,
    `status: ${task.status}`,
    `description: ${task.description ?? ''}`,
    `outcomes:\n${outcomes || '(none)'}`,
    `steps:\n${steps || '(none)'}`,
    `craftbookParams: ${JSON.stringify(task.craftbookParams ?? {})}`,
  ].join('\n');
}

function taskAssigneeGezelId(task: Task): string | undefined {
  const assignee = task.assignee as { kind?: string; gezelId?: string } | undefined;
  return assignee?.kind === 'gezel' ? assignee.gezelId : undefined;
}

async function taskGraphTextForSpec(
  client: GezelClient,
  projectId: string,
  spec: CraftbookEvalSpec,
): Promise<{
  text: string;
  failures: string[];
  taskCount: number;
  matchingCraftbookTaskCount: number;
  authoringGezelId?: string;
}> {
  const listed = await client.listProjectTasks(projectId);
  const matching = listed.tasks.filter((task) => taskMatchesCraftbook(task, spec));
  const failures: string[] = [];
  if (spec.success.taskGraph?.requireCraftbookTask && matching.length === 0) {
    failures.push(
      `no task sourced from craftbook ${spec.craftbookId}; saw ${listed.tasks.length} task(s)`,
    );
  }

  const authoringTask = matching[0];
  let draftTask: Task | null = null;
  const draftRef = authoringTask?.craftbookParams?.draftRef;
  if (spec.success.taskGraph?.requireDraftRef && !draftRef) {
    failures.push(`no draftRef found on task sourced from craftbook ${spec.craftbookId}`);
  }
  if (draftRef) {
    try {
      draftTask = await client.getTaskByRef(draftRef);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`could not read draft task ${draftRef}: ${msg}`);
    }
  }

  const draftChecks = spec.success.taskGraph?.draft;
  if (draftChecks) {
    if (!draftTask) {
      failures.push('no draft task available for taskGraph.draft checks');
    } else {
      if (draftChecks.status && draftTask.status !== draftChecks.status) {
        failures.push(
          `draft ${draftTask.ref} status ${draftTask.status}; expected ${draftChecks.status}`,
        );
      }
      if (
        draftChecks.minDescriptionBytes !== undefined &&
        (draftTask.description ?? '').length < draftChecks.minDescriptionBytes
      ) {
        failures.push(
          `draft ${draftTask.ref} description is ${(draftTask.description ?? '').length} bytes; expected at least ${draftChecks.minDescriptionBytes}`,
        );
      }
      if (
        draftChecks.minOutcomes !== undefined &&
        (draftTask.outcomes ?? []).length < draftChecks.minOutcomes
      ) {
        failures.push(
          `draft ${draftTask.ref} has ${(draftTask.outcomes ?? []).length} outcomes; expected at least ${draftChecks.minOutcomes}`,
        );
      }
      if (
        draftChecks.minSteps !== undefined &&
        draftTask.craftbook.steps.length < draftChecks.minSteps
      ) {
        failures.push(
          `draft ${draftTask.ref} has ${draftTask.craftbook.steps.length} steps; expected at least ${draftChecks.minSteps}`,
        );
      }
      if (draftChecks.requireTerminalVerification) {
        const hasVerification = draftTask.craftbook.steps.some((step) => {
          if (!step.terminal) return false;
          const text = JSON.stringify(step).toLowerCase();
          return text.includes('verify') || text.includes('outcome') || text.includes('evidence');
        });
        if (!hasVerification) {
          failures.push(`draft ${draftTask.ref} has no terminal verification/outcomes step`);
        }
      }
      if (draftChecks.requireGatedBuildSteps) {
        const buildSteps = draftTask.craftbook.steps.filter((step) => !step.terminal);
        const ungated = buildSteps.filter((step) => !step.gate && !step.advanceWhen);
        if (buildSteps.length === 0) {
          failures.push(`draft ${draftTask.ref} has no non-terminal build steps`);
        } else if (ungated.length > 0) {
          failures.push(
            `draft ${draftTask.ref} has ungated build steps: ${ungated.map((step) => step.id).join(', ')}`,
          );
        }
      }
    }
  }

  return {
    text: [
      `Project tasks: ${listed.tasks.length}`,
      `Matching craftbook tasks: ${matching.length}`,
      authoringTask ? `Authoring task:\n${taskSummary(authoringTask)}` : 'Authoring task: (none)',
      draftTask ? `Draft task:\n${taskSummary(draftTask)}` : 'Draft task: (none)',
    ].join('\n\n'),
    failures,
    taskCount: listed.tasks.length,
    matchingCraftbookTaskCount: matching.length,
    ...(authoringTask ? { authoringGezelId: taskAssigneeGezelId(authoringTask) } : {}),
  };
}

function successChecksForSpec(spec: CraftbookEvalSpec) {
  const checks = [...(spec.success.checks ?? [])];
  for (const deliverable of spec.success.deliverables ?? []) {
    // completionGate only understands core GateChecks; eval-only checks
    // (e.g. prometheusAlerts) are appended directly after the gate runs.
    const coreChecks: GateCheck[] = [];
    const evalChecks: CraftbookEvalGateCheck[] = [];
    for (const check of deliverable.checks ?? []) {
      if (check.kind === 'prometheusAlerts' || check.kind === 'nodeScriptPasses') {
        evalChecks.push(check);
      } else {
        coreChecks.push(check);
      }
    }
    const gate = completionGate(
      {
        path: deliverable.path,
        kind: deliverable.kind,
        ...(deliverable.minBytes !== undefined ? { minBytes: deliverable.minBytes } : {}),
        ...(coreChecks.length > 0 ? { extraChecks: coreChecks } : {}),
      },
      'eval',
      1,
    );
    checks.push(...(gate.checks ?? []));
    checks.push(...evalChecks);
  }
  if (spec.success.taskNotes) {
    checks.push({
      kind: 'minBytes',
      file: 'task-notes.md',
      bytes: spec.success.taskNotes.minBytes ?? 120,
    });
    checks.push(...(spec.success.taskNotes.checks ?? []));
  }
  if (spec.success.taskGraph) {
    checks.push({
      kind: 'minBytes',
      file: 'task-graph.md',
      bytes: 120,
    });
    checks.push(...(spec.success.taskGraph.checks ?? []));
  }
  return checks;
}

function failureMentionsPath(failure: string, path: string): boolean {
  return (
    failure === path ||
    failure.startsWith(`${path} `) ||
    failure.startsWith(`${path}:`) ||
    failure.startsWith(`${path} is`) ||
    failure.startsWith(`${path} contains`) ||
    failure.startsWith(`${path} should`)
  );
}

function failureReferencesPath(failure: string, path: string): boolean {
  return failureMentionsPath(failure, path) || failure.includes(path);
}

function repairDeliverableForFailures(
  spec: CraftbookEvalSpec,
  failures: readonly string[],
): CraftbookEvalDeliverable | undefined {
  const deliverables = spec.success.deliverables ?? [];
  return (
    deliverables.find((deliverable) =>
      failures.some((failure) => failureMentionsPath(failure, deliverable.path)),
    ) ?? deliverables[0]
  );
}

function repairFailuresForDeliverable(
  failures: readonly string[],
  deliverable: CraftbookEvalDeliverable | undefined,
): string[] {
  if (!deliverable) return prioritizeRepairFailures(failures);
  const local = failures.filter((failure) => failureReferencesPath(failure, deliverable.path));
  return prioritizeRepairFailures(local.length > 0 ? local : failures);
}

function repairTargetForFailures(
  spec: CraftbookEvalSpec,
  failures: readonly string[],
): {
  deliverable: CraftbookEvalDeliverable | undefined;
  failures: string[];
} {
  const deliverables = spec.success.deliverables ?? [];
  const prioritized = prioritizeRepairFailuresForTarget(deliverables, failures);
  const executableSemanticDependency = executableSemanticDependencyDeliverable(
    deliverables,
    failures,
  );
  if (executableSemanticDependency) {
    return {
      deliverable: executableSemanticDependency,
      failures: repairFailuresForDeliverable(failures, executableSemanticDependency),
    };
  }
  const executableAssertionDependency = executableAssertionDependencyDeliverable(
    deliverables,
    failures,
  );
  if (executableAssertionDependency) {
    return {
      deliverable: executableAssertionDependency,
      failures: repairFailuresForDeliverable(failures, executableAssertionDependency),
    };
  }
  const executableDependency = prioritized
    .map((failure) => executableFailureDependencyDeliverable(deliverables, failure))
    .find((deliverable): deliverable is CraftbookEvalDeliverable => deliverable !== undefined);
  if (executableDependency) {
    return {
      deliverable: executableDependency,
      failures: repairFailuresForDeliverable(failures, executableDependency),
    };
  }
  const firstPath = prioritized.find((failure) =>
    deliverables.some((deliverable) => failureMentionsPath(failure, deliverable.path)),
  );
  const deliverableFromPriority = firstPath
    ? deliverables.find((deliverable) => failureMentionsPath(firstPath, deliverable.path))
    : undefined;
  const deliverable = deliverableFromPriority ?? repairDeliverableForFailures(spec, failures);
  return {
    deliverable,
    failures: repairFailuresForDeliverable(failures, deliverable),
  };
}

function executableSemanticDependencyDeliverable(
  deliverables: readonly CraftbookEvalDeliverable[],
  failures: readonly string[],
): CraftbookEvalDeliverable | undefined {
  const executableFailure = failures.find(isExecutableFailure);
  if (!executableFailure) return undefined;
  const directDeliverable = deliverables.find((deliverable) =>
    failureMentionsPath(executableFailure, deliverable.path),
  );
  if (!directDeliverable || directDeliverable.kind !== 'code-with-tests') return undefined;
  if (
    failures.some(
      (failure) =>
        isSevereMinBytesFailure(failure) && failureMentionsPath(failure, directDeliverable.path),
    )
  ) {
    return undefined;
  }
  return deliverables.find(
    (deliverable) =>
      deliverable.path !== directDeliverable.path &&
      deliverable.kind === 'code-module' &&
      failures.some(
        (failure) =>
          failureMentionsPath(failure, deliverable.path) &&
          !isMinBytesFailure(failure) &&
          !isExecutableFailure(failure),
      ),
  );
}

function executableAssertionDependencyDeliverable(
  deliverables: readonly CraftbookEvalDeliverable[],
  failures: readonly string[],
): CraftbookEvalDeliverable | undefined {
  const executableFailure = failures.find(isExecutableFailure);
  if (!executableFailure) return undefined;
  if (
    /SyntaxError|ERR_MODULE_NOT_FOUND|Identifier .+ already been declared/i.test(executableFailure)
  ) {
    return undefined;
  }
  if (
    !/AssertionError|mismatch|Expected .* got|FAIL:\s*(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(
      executableFailure,
    )
  ) {
    return undefined;
  }
  const directDeliverable = deliverables.find((deliverable) =>
    failureMentionsPath(executableFailure, deliverable.path),
  );
  if (!directDeliverable || directDeliverable.kind !== 'code-with-tests') return undefined;
  if (
    failures.some(
      (failure) =>
        isSevereMinBytesFailure(failure) && failureMentionsPath(failure, directDeliverable.path),
    )
  ) {
    return undefined;
  }
  return deliverables.find(
    (deliverable) =>
      deliverable.path !== directDeliverable.path && deliverable.kind === 'code-module',
  );
}

function prioritizeRepairFailuresForTarget(
  deliverables: readonly CraftbookEvalDeliverable[],
  failures: readonly string[],
): string[] {
  const prioritized = prioritizeRepairFailures(failures);
  const severeMinBytesPaths = new Set(
    failures
      .filter(isSevereMinBytesFailure)
      .map((failure) => deliverablePathForFailure(deliverables, failure))
      .filter((path): path is string => path !== undefined),
  );
  if (severeMinBytesPaths.size === 0) return prioritized;
  if (failures.some(isEmptyMinBytesFailure)) return prioritized;

  const crossDeliverableSemanticFailures = failures.filter((failure) => {
    if (isMinBytesFailure(failure) || isExecutableFailure(failure)) return false;
    const path = deliverablePathForFailure(deliverables, failure);
    return path !== undefined && !severeMinBytesPaths.has(path);
  });
  if (crossDeliverableSemanticFailures.length === 0) return prioritized;

  const semanticSet = new Set(crossDeliverableSemanticFailures);
  return [
    ...crossDeliverableSemanticFailures,
    ...prioritized.filter((failure) => !semanticSet.has(failure)),
  ];
}

function deliverablePathForFailure(
  deliverables: readonly CraftbookEvalDeliverable[],
  failure: string,
): string | undefined {
  return deliverables.find((deliverable) => failureMentionsPath(failure, deliverable.path))?.path;
}

function executableFailureDependencyDeliverable(
  deliverables: readonly CraftbookEvalDeliverable[],
  failure: string,
): CraftbookEvalDeliverable | undefined {
  if (!isExecutableFailure(failure)) return undefined;
  const directDeliverable = deliverables.find((deliverable) =>
    failureMentionsPath(failure, deliverable.path),
  );
  return deliverables.find(
    (deliverable) =>
      deliverable.path !== directDeliverable?.path &&
      failureReferencesPath(failure, deliverable.path),
  );
}

function repairVirtualTargetForFailures(
  spec: CraftbookEvalSpec,
  failures: readonly string[],
): { path: 'task-notes.md' | 'task-graph.md'; failures: string[] } | undefined {
  const prioritized = prioritizeRepairFailures(failures);
  if (spec.success.taskNotes) {
    const taskNoteFailures = prioritized.filter((failure) =>
      failureMentionsPath(failure, 'task-notes.md'),
    );
    if (taskNoteFailures.length > 0) {
      return { path: 'task-notes.md', failures: taskNoteFailures };
    }
  }
  if (!spec.success.taskGraph) return undefined;
  const taskGraphFailures = prioritized.filter(
    (failure) =>
      failureMentionsPath(failure, 'task-graph.md') ||
      failure.startsWith('no task sourced from craftbook') ||
      failure.startsWith('no draftRef') ||
      failure.startsWith('no draft task') ||
      failure.startsWith('draft ') ||
      failure.startsWith('could not read draft task'),
  );
  return taskGraphFailures.length > 0
    ? { path: 'task-graph.md', failures: taskGraphFailures }
    : undefined;
}

function taskGraphRepairDirective(taskGraph: { text: string } | undefined): string {
  const draftRef = taskGraph?.text.match(/Draft task:\s*Task\s+([^:\n]+):/)?.[1];
  const draftArg = draftRef ? JSON.stringify(draftRef) : '"<draftRef>"';
  return [
    'TASK_GRAPH_REPAIR: `task-graph.md` is a virtual grader view of the task graph; do not write, patch, or create a file named `task-graph.md`.',
    'Fix the actual draft task with task/craftbook tools, then stop.',
    draftRef
      ? `Target draft task: \`${draftRef}\`.`
      : 'If no draft task exists yet, invoke/start the requested craftbook flow to create the draft task first.',
    'For an ungated-step failure, your next assistant action MUST be a `set_step_deliverable` tool call for one of the named step ids; do not answer in prose and do not write task-graph.md.',
    `For every ungated build step named in the failure, call \`set_step_deliverable({ task: ${draftArg}, stepId: "<stepId>", path: "index.html", kind: "html-page" })\`; this attaches the gate the eval is checking.`,
    `If there are fewer than three steps, add concrete build steps to ${draftArg}, then immediately attach a deliverable with \`set_step_deliverable\`.`,
    `If verification is missing, call \`add_verification_step({ task: ${draftArg} })\`.`,
    'Do not use `update_task` prose/plan text as a substitute for step deliverables; the grader checks the structured task graph.',
  ].join(' ');
}

function isMinBytesFailure(failure: string): boolean {
  return /\bis \d+ bytes, need ≥ \d+/.test(failure);
}

function minBytesRatio(failure: string): number | null {
  const match = failure.match(/\bis (\d+) bytes, need ≥ (\d+)/);
  if (!match) return null;
  const actual = Number(match[1]);
  const required = Number(match[2]);
  if (!Number.isFinite(actual) || !Number.isFinite(required) || required <= 0) return null;
  return actual / required;
}

function isSevereMinBytesFailure(failure: string): boolean {
  const ratio = minBytesRatio(failure);
  return ratio !== null && ratio < 0.5;
}

function isEmptyMinBytesFailure(failure: string): boolean {
  return /\bis 0 bytes, need ≥ \d+/.test(failure);
}

function isExecutableFailure(failure: string): boolean {
  return /\bdid not pass when run with node\b/.test(failure);
}

/**
 * Within the semantic bucket, structural TOTALS (record-count floors,
 * value-conservation counts, file-count floors) outrank per-record field
 * misses. Per-record failures are a treadmill: each nudge headlines a
 * different record ("record 4 is missing caption" → record 5 → record 6)
 * and the model chases them one at a time while the binding gap — two
 * whole records were dropped — never leads. Wild-caught: album-curate
 * (gemma4-e4b, 2026-07-25 matrix) grew the file 4 polls in a row adding
 * captions while the count stayed 8/10 to trial death.
 */
function isStructuralTotalFailure(failure: string): boolean {
  return (
    /\b\d+ record\(s\), need ≥ \d+/.test(failure) ||
    /output carries \d+ value\(s\)/.test(failure) ||
    /value\(s\) in the output appear in no source/.test(failure) ||
    /\bfound \d+ [^,]* file\(s\)/.test(failure)
  );
}

function isPerRecordFieldFailure(failure: string): boolean {
  return /\brecord \d+ (?:is missing|has unexpected)/.test(failure);
}

function orderSemanticFailures(semantic: readonly string[]): string[] {
  const structural = semantic.filter(isStructuralTotalFailure);
  const perRecord = semantic.filter(
    (failure) => !isStructuralTotalFailure(failure) && isPerRecordFieldFailure(failure),
  );
  const rest = semantic.filter(
    (failure) => !isStructuralTotalFailure(failure) && !isPerRecordFieldFailure(failure),
  );
  return [...structural, ...rest, ...perRecord];
}

export function prioritizeRepairFailures(failures: readonly string[]): string[] {
  if (failures.length <= 1) return [...failures];
  const severeMinBytesFailures = failures.filter(isSevereMinBytesFailure);
  const executableFailures = failures.filter(isExecutableFailure);
  const semanticFailures = orderSemanticFailures(
    failures.filter((failure) => !isMinBytesFailure(failure) && !isExecutableFailure(failure)),
  );
  const otherMinBytesFailures = failures.filter(
    (failure) => isMinBytesFailure(failure) && !isSevereMinBytesFailure(failure),
  );
  if (severeMinBytesFailures.length > 0) {
    return [
      ...severeMinBytesFailures,
      ...executableFailures,
      ...semanticFailures,
      ...otherMinBytesFailures,
    ];
  }
  if (executableFailures.length > 0) {
    return [...executableFailures, ...semanticFailures, ...otherMinBytesFailures];
  }
  if (semanticFailures.length === 0) return [...failures];
  return [...semanticFailures, ...otherMinBytesFailures];
}

interface NoWriteRepairState {
  key: string;
  firstSeenAt: number;
  polls: number;
  baselineActivityMs: number;
  lastTextDigest: string;
  rewriteCount: number;
}

const NO_WRITE_REPAIR_MIN_POLLS = 3;
const NO_WRITE_REPAIR_MIN_AGE_MS = 60_000;
const NO_WRITE_REPAIR_INFLIGHT_DEFER_MS = 4 * 60_000;

function stableDigest(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function noWriteRepairKey(args: {
  projectId: string;
  filePath: string;
  failures: readonly string[];
  passed: number;
  total: number;
}): string {
  const failureDigest = stableDigest(args.failures.slice(0, 4).join('\n'));
  return [args.projectId, args.filePath, `${args.passed}/${args.total}`, failureDigest].join(':');
}

async function maxProjectSessionActivityMs(
  client: GezelClient,
  projectId: string,
): Promise<number | null> {
  try {
    const { sessions } = await client.listChatSessions({ projectId });
    let max = 0;
    for (const session of sessions ?? []) {
      const ts = session.lastActivityAt ? Date.parse(session.lastActivityAt) : 0;
      if (Number.isFinite(ts) && ts > max) max = ts;
    }
    return max;
  } catch {
    return null;
  }
}

async function hasYoungProjectInflightTurn(
  client: GezelClient,
  projectId: string,
): Promise<boolean> {
  const maybeClient = client as unknown as {
    listInflightTurns?: (opts?: { projectId?: string }) => Promise<{
      inflight?: Array<{ projectId?: string; elapsedMs?: number }>;
    }>;
  };
  if (typeof maybeClient.listInflightTurns !== 'function') return false;
  try {
    const { inflight = [] } = await maybeClient.listInflightTurns({ projectId });
    return inflight.some((turn) => {
      if (turn.projectId && turn.projectId !== projectId) return false;
      return (turn.elapsedMs ?? 0) < NO_WRITE_REPAIR_INFLIGHT_DEFER_MS;
    });
  } catch {
    return false;
  }
}

export function craftbookScenarioFromSpec(spec: CraftbookEvalSpec): EvalScenario {
  if (!spec.prompt) {
    throw new Error(`craftbook eval ${spec.scenarioId} needs a prompt`);
  }
  const prompt = craftbookEvalKickoffPrompt(spec);
  let noWriteRepairState: NoWriteRepairState | null = null;
  // Advisory judge wiring from the book's test.json rubric: --llm-judge
  // scores these axes against the primary artifact. Never affects
  // pass/fail — deterministic checks alone decide that.
  const judge = spec.rubric
    ? {
        artifactBasename: spec.rubric.artifact.path.split('/').pop() ?? spec.rubric.artifact.path,
        artifactKind: spec.rubric.artifact.kind,
        axes: spec.rubric.axes,
        ...(spec.rubric.contextNote ? { contextNote: spec.rubric.contextNote } : {}),
      }
    : undefined;
  return {
    id: spec.scenarioId,
    description: `${spec.title}: ${spec.objective}`,
    prompt,
    suggestedTrials: 1,
    ...(judge ? { judge } : {}),
    ...(spec.mocks && spec.mocks.length > 0 ? { mockServices: spec.mocks } : {}),
    // Books whose deterministic success needs raster files must declare an
    // image model, exactly like petshop/tool-routing-image. This is what
    // arms the runner's whole image path — resolve/require sd-server, warm
    // or link local weights, configure the trial daemon. Without it the
    // harness installs the images TOOLSET but never provisions the ENGINE,
    // and the trial runs unwinnable-by-design while the failure books as
    // "model" (wild-caught: page-spread, tileset-batch, 2026-07-24 matrix).
    ...(directWorkerNeedsImageToolset(spec) ? { defaultImageModelId: 'sdxl-lightning-4step' } : {}),
    skipInitialPrompt: !!spec.setup?.worker,
    async setup(ctx) {
      const projectId = await ensureProject(ctx, spec);
      if (projectId) await writeFixtureFiles(ctx, projectId, spec);
      if (projectId && ctx.mocks) await setupMockServices(ctx, projectId, spec);
      // Meester-routed books (no direct worker) still need the fake MCP
      // on the gezel that receives the kickoff.
      if (projectId && ctx.mocks && !spec.setup?.worker) {
        await installMockMcpToolsets(ctx, spec, ctx.meesterId);
      }
      if (projectId && spec.setup?.worker) {
        const workerId = await ensureWorker(ctx, spec);
        if (!workerId) return;
        if (ctx.mocks) await installMockMcpToolsets(ctx, spec, workerId);
        if (directWorkerNeedsWorkspaceToolsets(spec)) {
          await ensureWorkspaceToolsetsForWorker(ctx.client, workerId);
          ctx.log(
            `[craftbook:${spec.craftbookId}] installed workspace eval toolsets for ${workerId}`,
          );
        }
        // A cli-shim mock is USED via `run_script` — that tool lives in
        // the code-execution builtin toolset, which the workspace set
        // above does not include. Without this install the probe tool is
        // absent from the MCP bridge entirely (wild-caught: four ship
        // pilot attempts where no prompt or feedback could ever work).
        if (spec.mocks?.some((mock) => mock.kind === 'cli')) {
          await ctx.client.installToolset('builtin.code-execution', {
            scope: { kind: 'gezel', gezelId: workerId },
          });
          ctx.log(
            `[craftbook:${spec.craftbookId}] installed code-execution toolset for ${workerId} (cli-shim mocks)`,
          );
        }
        if (directWorkerNeedsImageToolset(spec)) {
          await ctx.client.installToolset('builtin.images', {
            scope: { kind: 'gezel', gezelId: workerId },
          });
          ctx.log(
            `[craftbook:${spec.craftbookId}] installed images toolset for ${workerId} (raster deliverables)`,
          );
        }
        await ctx.client.addGezelToProject(projectId, workerId);
        ctx.log(
          `[craftbook:${spec.craftbookId}] joined worker ${workerId} to project ${projectId}`,
        );
        // Spawn/fanout books run as a real craftbook task so the runtime
        // drives the steps + declarative fanout; every other book keeps the
        // freehand direct-worker kickoff.
        if (spec.runAsCraftbookTask) {
          await dispatchCraftbookTask(ctx, spec, projectId, workerId);
        } else {
          const primaryDeliverablePath = spec.success.deliverables?.[0]?.path;
          await ctx.client.sendChatMessage(workerId, {
            message: ctx.mocks ? ctx.mocks.substitute(prompt) : prompt,
            projectId,
            ...(primaryDeliverablePath
              ? {
                  expectedDeliverable: {
                    kind: 'file' as const,
                    filePath: primaryDeliverablePath,
                  },
                }
              : {}),
          });
          ctx.log(
            `[craftbook:${spec.craftbookId}] sent kickoff to ${spec.setup.worker.name} in project ${projectId}`,
          );
        }
      }
    },
    async successCheck(ctx): Promise<SuccessCheckResult> {
      const projectName = spec.setup?.projectName;
      if (!projectName) return { done: false };
      const projectId = await findProjectId(ctx.client, projectName);
      if (!projectId) return { done: false };

      const checks = successChecksForSpec(spec);
      const workspace = workspaceFromClient(ctx.client, projectId);
      const primaryDeliverable = spec.success.deliverables?.[0];
      const primaryText = primaryDeliverable ? await workspace.read(primaryDeliverable.path) : null;
      let taskNotes:
        | { text: string; taskCount: number; matchingCraftbookTaskCount: number }
        | undefined;
      let taskGraph:
        | {
            text: string;
            failures: string[];
            taskCount: number;
            matchingCraftbookTaskCount: number;
            authoringGezelId?: string;
          }
        | undefined;
      let gateWorkspace = workspace;
      if (spec.success.taskNotes || spec.success.taskGraph) {
        const virtualFiles = new Map<string, string>();
        if (spec.success.taskNotes) {
          taskNotes = await taskNotesTextForSpec(ctx.client, projectId, spec);
          virtualFiles.set('task-notes.md', taskNotes.text);
        }
        if (spec.success.taskGraph) {
          taskGraph = await taskGraphTextForSpec(ctx.client, projectId, spec);
          virtualFiles.set('task-graph.md', taskGraph.text);
        }
        gateWorkspace = {
          async read(file: string): Promise<string | null> {
            if (virtualFiles.has(file)) return virtualFiles.get(file) ?? '';
            return workspace.read(file);
          },
          async list(): Promise<string[]> {
            return [...(await workspace.list()), ...virtualFiles.keys()];
          },
        };
      }
      const result = await evaluateCraftbookGateChecks(checks, gateWorkspace);
      const failures = [...result.failures];
      if (
        spec.success.taskNotes?.requireCraftbookTask &&
        taskNotes?.matchingCraftbookTaskCount === 0
      ) {
        failures.unshift(
          `no task sourced from craftbook ${spec.craftbookId}; saw ${taskNotes.taskCount} task(s)`,
        );
      }
      if (taskGraph) failures.unshift(...taskGraph.failures);
      if (spec.success.mocks && spec.success.mocks.length > 0 && ctx.mocks) {
        failures.push(...evaluateMockExpectations(spec.success.mocks, ctx.mocks));
      }
      const unreadSeededPaths = await missingSeededReads(ctx.client, projectId, spec);
      if (unreadSeededPaths.length > 0) {
        failures.unshift(
          `seeded workspace input(s) have not been read yet: ${unreadSeededPaths.join(', ')}`,
        );
      }
      const repairFailures = prioritizeRepairFailures(failures);
      const passed = Math.max(0, checks.length - failures.length);
      const sniffBytes =
        primaryDeliverable !== undefined
          ? (primaryText?.length ?? 0)
          : (taskNotes?.text.length ?? taskGraph?.text.length ?? 0);
      ctx.recordSniff?.({
        key: spec.scenarioId,
        score: passed,
        bytes: sniffBytes,
        failReason: repairFailures[0],
      });
      ctx.logChanged(
        `craftbook:${spec.scenarioId}`,
        `[scenario] ${spec.scenarioId} bytes=${sniffBytes} checks=${passed}/${checks.length} failures=${failures.join(' | ') || 'none'}`,
      );

      if (failures.length === 0) {
        noWriteRepairState = null;
        return {
          done: true,
          success: true,
          reason: `${spec.scenarioId} passed ${checks.length} deterministic craftbook checks`,
        };
      }

      const hasConcreteDeliverableFailures = failures.some(
        (failure) =>
          !failure.startsWith('seeded workspace input') &&
          (spec.success.deliverables ?? []).some((deliverable) =>
            failureReferencesPath(failure, deliverable.path),
          ),
      );
      if (unreadSeededPaths.length > 0 && !hasConcreteDeliverableFailures) {
        noWriteRepairState = null;
        const feedbackPath = primaryDeliverable?.path ?? unreadSeededPaths[0] ?? spec.scenarioId;
        await postSniffFeedback(
          ctx,
          feedbackPath,
          {
            ok: false,
            signals: [],
            score: passed,
            failReason: repairFailures[0],
            missingRequiredSignals: repairFailures.slice(0, 4),
          },
          {
            projectId,
            expectedDeliverable: null,
            repairDirective: craftbookSourceReadRepairDirective(unreadSeededPaths),
          },
        );
        return { done: false };
      }

      const virtualRepairTarget = repairVirtualTargetForFailures(spec, failures);
      if (virtualRepairTarget) {
        noWriteRepairState = null;
        await postSniffFeedback(
          ctx,
          virtualRepairTarget.path,
          {
            ok: false,
            signals: [],
            score: passed,
            failReason: virtualRepairTarget.failures[0] ?? repairFailures[0],
            missingRequiredSignals: virtualRepairTarget.failures.slice(0, 4),
          },
          {
            projectId,
            targetGezelId:
              virtualRepairTarget.path === 'task-graph.md'
                ? taskGraph?.authoringGezelId
                : undefined,
            repairDirective:
              virtualRepairTarget.path === 'task-graph.md'
                ? taskGraphRepairDirective(taskGraph)
                : undefined,
            expectedDeliverable:
              virtualRepairTarget.path === 'task-notes.md'
                ? { kind: 'file', filePath: 'task-notes.md' }
                : null,
          },
        );
        return { done: false };
      }

      const repairTarget = repairTargetForFailures(spec, failures);
      const repairDeliverable = repairTarget.deliverable;
      const repairFeedbackFailures = repairTarget.failures;
      const repairDeliverablePath = repairDeliverable?.path ?? 'workspace output';
      const repairText =
        repairDeliverable && repairDeliverable.path === primaryDeliverable?.path
          ? primaryText
          : repairDeliverable
            ? await workspace.read(repairDeliverable.path)
            : null;
      if (repairDeliverable) {
        if (repairText === null) {
          noWriteRepairState = null;
          const nearMiss = await wrongSurfaceNearMiss(
            ctx.client,
            projectId,
            repairDeliverable.path,
          );
          await postMissingDeliverableFeedback(ctx, repairDeliverable.path, {
            projectId,
            nearMiss,
            repairDirective: craftbookMissingDeliverableRepairDirective(spec),
          });
          return { done: false };
        }
      }
      await postSniffFeedback(
        ctx,
        spec.success.taskNotes && !spec.success.deliverables?.[0]
          ? 'task-notes.md'
          : repairDeliverablePath,
        {
          ok: false,
          signals: [],
          score: passed,
          failReason: repairFeedbackFailures[0] ?? repairFailures[0],
          missingRequiredSignals: repairFeedbackFailures.slice(0, 4),
        },
        {
          projectId,
          expectedDeliverable: repairDeliverable
            ? { kind: 'file', filePath: repairDeliverable.path }
            : null,
        },
      );
      if (repairDeliverable && repairText !== null) {
        const key = noWriteRepairKey({
          projectId,
          filePath: repairDeliverable.path,
          failures: repairFeedbackFailures,
          passed,
          total: checks.length,
        });
        const textDigest = stableDigest(repairText);
        const now = Date.now();
        if (!noWriteRepairState || noWriteRepairState.key !== key) {
          noWriteRepairState = {
            key,
            firstSeenAt: now,
            polls: 1,
            baselineActivityMs: (await maxProjectSessionActivityMs(ctx.client, projectId)) ?? 0,
            lastTextDigest: textDigest,
            rewriteCount: 0,
          };
        } else {
          noWriteRepairState.polls += 1;
          if (noWriteRepairState.lastTextDigest !== textDigest) {
            noWriteRepairState.lastTextDigest = textDigest;
            noWriteRepairState.rewriteCount += 1;
          }
          const ageMs = now - noWriteRepairState.firstSeenAt;
          const currentActivityMs = await maxProjectSessionActivityMs(ctx.client, projectId);
          const activityAdvanced =
            currentActivityMs !== null && currentActivityMs > noWriteRepairState.baselineActivityMs;
          if (
            noWriteRepairState.polls >= NO_WRITE_REPAIR_MIN_POLLS &&
            ageMs >= NO_WRITE_REPAIR_MIN_AGE_MS &&
            activityAdvanced &&
            !(await hasYoungProjectInflightTurn(ctx.client, projectId))
          ) {
            const ageSeconds = Math.round(ageMs / 1000);
            const stabilityDetail =
              noWriteRepairState.rewriteCount > 0
                ? `was rewritten ${noWriteRepairState.rewriteCount} time(s) but kept failing the same gate for ${ageSeconds}s`
                : `stayed unchanged at ${repairText.length} bytes for ${ageSeconds}s`;
            return {
              done: true,
              success: false,
              failureMode: 'model-stuck',
              reason:
                `${spec.scenarioId} stale no-write repair loop: ${repairDeliverable.path} ` +
                `${stabilityDetail} after repair feedback ` +
                `and newer chat activity; still failing ${passed}/${checks.length}: ${repairFeedbackFailures[0] ?? repairFailures[0]}`,
            };
          }
        }
      } else {
        noWriteRepairState = null;
      }
      return { done: false };
    },
  };
}
