import { type GateCheck, type Task, completionGate } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { isBinaryDocumentDeliverablePath } from '../handoff.ts';
import {
  evaluateMockExpectations,
  mockMcpToolsetId,
  mockMcpUsesSystemSeed,
} from '../mock/mock-server.ts';
import {
  type MissingDeliverableNearMiss,
  postMissingDeliverableFeedback,
  postSniffFeedback,
} from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  type CraftbookEvalWorkspace,
  evaluateCraftbookGateChecks,
  isEvalOnlyCheck,
} from './gates.ts';
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

const CRAFTBOOK_TASK_EVAL_TOOLSET_IDS = ['builtin.artifacts', 'builtin.tasks'] as const;

function workspaceFixturePaths(spec: CraftbookEvalSpec): string[] {
  return (spec.setup?.files ?? [])
    .filter((file) => file.surface === undefined || file.surface === 'workspace')
    .map((file) => file.path);
}

/**
 * Harness-only fixtures still get seeded and remain available to browsers or
 * graders, but never appear in project context, kickoff reads, or source-read
 * enforcement. Executable grader scripts are implicitly harness-only; other
 * black-box fixtures opt out explicitly with `modelInput: false`.
 */
function sourceWorkspaceFixturePaths(spec: CraftbookEvalSpec): string[] {
  const checks: CraftbookEvalGateCheck[] = [
    ...(spec.success.checks ?? []),
    ...(spec.success.deliverables ?? []).flatMap((deliverable) => deliverable.checks ?? []),
    ...(spec.success.taskNotes?.checks ?? []),
    ...(spec.success.taskGraph?.checks ?? []),
  ];
  const graderScripts = new Set(
    checks.filter((check) => check.kind === 'nodeScriptPasses').map((check) => check.script),
  );
  return (spec.setup?.files ?? [])
    .filter(
      (file) =>
        (file.surface === undefined || file.surface === 'workspace') &&
        file.modelInput !== false &&
        !graderScripts.has(file.path),
    )
    .map((file) => file.path);
}

function workspaceDeliverablePaths(spec: CraftbookEvalSpec): string[] {
  return (spec.success.deliverables ?? [])
    .filter((deliverable) => !deliverable.artifact)
    .map((deliverable) => deliverable.path);
}

function artifactDeliverablePaths(spec: CraftbookEvalSpec): string[] {
  return (spec.success.deliverables ?? [])
    .filter((deliverable) => deliverable.artifact)
    .map((deliverable) => deliverable.path);
}

async function readDeliverable(
  workspace: CraftbookEvalWorkspace,
  deliverable: CraftbookEvalDeliverable,
): Promise<string | null> {
  if (deliverable.artifact) return workspace.readArtifact?.(deliverable.path) ?? null;
  return workspace.read(deliverable.path);
}

function splitDeliverablePaths(spec: CraftbookEvalSpec): {
  workspace: { text: string[]; binary: string[] };
  artifacts: { text: string[]; binary: string[] };
} {
  const split = (paths: string[]) => ({
    text: paths.filter((path) => !isBinaryDocumentDeliverablePath(path)),
    binary: paths.filter(isBinaryDocumentDeliverablePath),
  });
  return {
    workspace: split(workspaceDeliverablePaths(spec)),
    artifacts: split(artifactDeliverablePaths(spec)),
  };
}

function binaryProductionInstruction(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  return `Produce the real binary deliverable${paths.length === 1 ? '' : 's'} through the active craftbook production workflow: ${paths.map((path) => `\`${path}\``).join(', ')}. Author and review the text source first, then use DocBlocks \`convert_document\`, \`preview_document\`, and \`save_artifact\`; finally use \`copy_artifact_to_workspace\` to copy the saved binary bytes to each exact workspace path. Never call \`write_file\` with prose, base64, or hand-built OOXML for these binary paths, and do not replace the craftbook with an ad-hoc Developer handoff.`;
}

function artifactBinaryProductionInstruction(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  return `Produce the real binary artifact${paths.length === 1 ? '' : 's'} through the active craftbook workflow: ${paths.map((path) => `\`${path}\``).join(', ')}. Author and review the source, then use DocBlocks \`convert_document\`, \`preview_document\`, and \`save_artifact\` so the exact binary path remains in the artifacts drawer. Do not copy it into the workspace and do not substitute prose, base64, or hand-built OOXML.`;
}

function directWorkerNeedsWorkspaceToolsets(spec: CraftbookEvalSpec): boolean {
  return workspaceFixturePaths(spec).length > 0 || workspaceDeliverablePaths(spec).length > 0;
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
  const seededPaths = sourceWorkspaceFixturePaths(spec);
  const workspaceOutputs = workspaceDeliverablePaths(spec);
  const artifactOutputs = artifactDeliverablePaths(spec);
  const lines = [
    '### Eval harness rules',
    'This is a self-contained craftbook eval project. Source paths are project workspace paths; declared artifact outputs live in the project artifacts drawer.',
    seededPaths.length > 0
      ? `Seeded workspace inputs: ${seededPaths.map((path) => `\`${path}\``).join(', ')}. Read them with the workspace \`read_file\` tool, not artifact/document/library tools.`
      : null,
    workspaceOutputs.length > 0
      ? `Required workspace deliverable${workspaceOutputs.length === 1 ? '' : 's'}: ${workspaceOutputs.map((path) => `\`${path}\``).join(', ')}. Chat summaries, artifacts, plans, and task notes do not satisfy workspace file deliverables.`
      : null,
    artifactOutputs.length > 0
      ? `Required artifact deliverable${artifactOutputs.length === 1 ? '' : 's'}: ${artifactOutputs.map((path) => `\`${path}\``).join(', ')}. Write and re-read these with \`write_artifact\` / \`read_artifact\`; workspace copies and task notes do not satisfy them.`
      : null,
  ].filter((line): line is string => !!line);
  return [spec.setup?.about?.trim(), lines.join('\n\n')].filter(Boolean).join('\n\n');
}

function craftbookEvalMissionObjectives(spec: CraftbookEvalSpec): string {
  const splitOutputs = splitDeliverablePaths(spec);
  const harnessMission = spec.success.taskGraph
    ? [
        'Use the requested craftbook/template when available, then produce the required structured task graph in this project.',
        'The eval output is the draft task graph itself, not a workspace artifact. Do not activate the draft or build the planned deliverable unless the prompt explicitly asks for execution.',
        'If invoking the craftbook creates an authoring task, keep working on that authoring task until the draft has the required outcomes, gated build steps, and verification step.',
      ]
    : [
        'Use the requested craftbook/template when available, then execute the work in this project until the deterministic eval outputs exist.',
        splitOutputs.workspace.text.length + splitOutputs.workspace.binary.length > 0
          ? `Land the final workspace file${splitOutputs.workspace.text.length + splitOutputs.workspace.binary.length === 1 ? '' : 's'} at the exact workspace-root-relative path${splitOutputs.workspace.text.length + splitOutputs.workspace.binary.length === 1 ? '' : 's'}: ${[...splitOutputs.workspace.text, ...splitOutputs.workspace.binary].map((path) => `\`${path}\``).join(', ')}.`
          : null,
        splitOutputs.artifacts.text.length + splitOutputs.artifacts.binary.length > 0
          ? `Land the final artifact${splitOutputs.artifacts.text.length + splitOutputs.artifacts.binary.length === 1 ? '' : 's'} at the exact artifacts-drawer path${splitOutputs.artifacts.text.length + splitOutputs.artifacts.binary.length === 1 ? '' : 's'}: ${[...splitOutputs.artifacts.text, ...splitOutputs.artifacts.binary].map((path) => `\`${path}\``).join(', ')}.`
          : null,
        binaryProductionInstruction(splitOutputs.workspace.binary),
        artifactBinaryProductionInstruction(splitOutputs.artifacts.binary),
        splitOutputs.workspace.binary.length + splitOutputs.artifacts.binary.length > 0
          ? 'If invoking the craftbook creates a task, keep carrying out its active production step; do not convert the binary output into an ad-hoc expected-file handoff.'
          : 'If invoking the craftbook creates a task, do not stop after creating or assigning it; carry out the active step or hand it to an appropriate gezel with an explicit expected file deliverable.',
      ];
  return [spec.setup?.missionObjectives?.trim(), ...harnessMission].filter(Boolean).join('\n');
}

function craftbookEvalKickoffPrompt(spec: CraftbookEvalSpec): string {
  const seededPaths = sourceWorkspaceFixturePaths(spec);
  const splitOutputs = splitDeliverablePaths(spec);
  const readCalls = seededPaths.map((path) => `read_file({ path: "${path}" })`);
  const harnessLines = [
    '[craftbook eval harness]',
    'This project is self-contained; all referenced source paths are workspace-root-relative.',
    seededPaths.length > 0
      ? `Before writing any deliverable, read every seeded input with workspace file tools: ${readCalls.map((call) => `\`${call}\``).join(', ')}. Do not use \`read_artifact\`, \`read_document\`, or library tools for these workspace files.`
      : 'Use workspace file tools for any project files you need to inspect.',
    splitOutputs.workspace.text.length > 0
      ? `Write the text workspace deliverable${splitOutputs.workspace.text.length === 1 ? '' : 's'} with \`write_file\` at the exact path${splitOutputs.workspace.text.length === 1 ? '' : 's'}: ${splitOutputs.workspace.text.map((path) => `\`${path}\``).join(', ')} (not \`workspace/<path>\`).`
      : null,
    splitOutputs.artifacts.text.length > 0
      ? `Write the text artifact deliverable${splitOutputs.artifacts.text.length === 1 ? '' : 's'} with \`write_artifact\` at the exact artifacts-drawer path${splitOutputs.artifacts.text.length === 1 ? '' : 's'}: ${splitOutputs.artifacts.text.map((path) => `\`${path}\``).join(', ')}. Re-read it with \`read_artifact\`; do not create a workspace copy.`
      : null,
    binaryProductionInstruction(splitOutputs.workspace.binary),
    artifactBinaryProductionInstruction(splitOutputs.artifacts.binary),
    spec.success.taskGraph
      ? 'Use the requested craftbook/template by invoking it when needed, but keep the work task-native: create and complete the authoring flow for the draft task graph. Do not activate the draft and do not build the planned workspace artifact.'
      : 'Use the requested craftbook/template as guidance or by invoking it, but do not stop after creating a task. Execute the active craftbook step(s) now until the required output exists.',
    '',
    spec.prompt,
  ].filter((line): line is string => !!line);
  return harnessLines.join('\n');
}

function craftbookMissingDeliverableRepairDirective(spec: CraftbookEvalSpec): string {
  const seededPaths = sourceWorkspaceFixturePaths(spec);
  const outputs = splitDeliverablePaths(spec);
  const lines = [
    '[craftbook eval repair]',
    seededPaths.length > 0
      ? `The source fixture is already in this project workspace: ${seededPaths.map((path) => `\`${path}\``).join(', ')}. If you need source content, call workspace \`read_file\` on that exact path; do not ask the user for it and do not use artifact/document/library tools.`
      : null,
    outputs.workspace.text.length > 0
      ? `Text workspace deliverables must be written with \`write_file\`: ${outputs.workspace.text.map((path) => `\`${path}\``).join(', ')}. Do not substitute \`write_artifact\` or \`write_document\` for those workspace files.`
      : null,
    outputs.artifacts.text.length > 0
      ? `Text artifact deliverables must be written with \`write_artifact\`: ${outputs.artifacts.text.map((path) => `\`${path}\``).join(', ')}. Re-read them with \`read_artifact\` and do not substitute workspace files.`
      : null,
    binaryProductionInstruction(outputs.workspace.binary),
    artifactBinaryProductionInstruction(outputs.artifacts.binary),
    outputs.workspace.binary.length + outputs.artifacts.binary.length > 0
      ? 'If you invoked a craftbook task, do not wait for another assignee and do not make an ad-hoc binary file handoff. Continue its production step through DocBlocks and copy the saved binary artifact to the required workspace path.'
      : 'If you invoked a craftbook task, do not wait for another assignee before producing the eval deliverable. Execute the active step yourself or make an explicit file-deliverable handoff, then write the required file.',
  ].filter((line): line is string => !!line);
  return lines.join('\n');
}

function craftbookExistingDeliverableRepairDirective(filePath: string): string | undefined {
  if (!isBinaryDocumentDeliverablePath(filePath)) return undefined;
  return [
    'BINARY_PRODUCTION_REQUIRED: do not repair this path with `write_file`, prose, base64, HTML, or hand-built OOXML.',
    'Return to the active craftbook workflow: use the approved Markdown source, call DocBlocks `convert_document`, inspect it with `preview_document`, persist it with `save_artifact`, then call `copy_artifact_to_workspace` so the real saved bytes land at the exact requested workspace path.',
  ].join(' ');
}

function craftbookSourceReadRepairDirective(missingPaths: readonly string[]): string {
  const calls = missingPaths.map((path) => `read_file({ path: "${path}" })`);
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
      if (call.name !== 'read_file' || call.success === false) continue;
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
  const seededPaths = sourceWorkspaceFixturePaths(spec);
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
    if (file.surface === 'harness') {
      continue;
    }
    if (file.surface === 'artifact') {
      await ctx.client.writeProjectArtifact(projectId, file.path, content);
    } else {
      await ctx.client.writeProjectWorkspaceFile(projectId, { path: file.path, content });
    }
  }
}

async function applyProjectWritePolicy(
  ctx: EvalContext,
  projectId: string,
  spec: CraftbookEvalSpec,
): Promise<void> {
  const managedWorkspaceWritePolicy = spec.setup?.managedWorkspaceWritePolicy;
  if (!managedWorkspaceWritePolicy) return;
  await ctx.client.updateProject(projectId, { managedWorkspaceWritePolicy });
  ctx.log(
    `[craftbook:${spec.craftbookId}] set managed workspace writes to ${managedWorkspaceWritePolicy} on ${projectId}`,
  );
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
  mocks.bindProject(projectId);
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
 * Install the local-catalog MCP toolset for every `mcp` mock at project
 * scope. The runner already wrote the
 * manifests into the trial home's local catalog root before the daemon
 * spawned, so this rides the ordinary catalog-install rail. Project scope is
 * load-bearing for multi-role craftbooks: Planner, Copywriter, Designer, and
 * Reviewer sessions must all see the same fake dependency.
 */
async function installMockMcpToolsets(
  ctx: EvalContext,
  spec: CraftbookEvalSpec,
  projectId: string,
): Promise<void> {
  for (const mock of spec.mocks ?? []) {
    if (mock.kind !== 'mcp') continue;
    const toolsetId = mockMcpToolsetId(mock.id, mock.toolsetId);
    if (mockMcpUsesSystemSeed(mock.id, mock.toolsetId)) {
      ctx.log(
        `[craftbook:${spec.craftbookId}] using pre-seeded system mock ${toolsetId} for ${projectId}`,
      );
      continue;
    }
    await ctx.client.installToolset(toolsetId, {
      scope: { kind: 'project', projectId },
    });
    ctx.log(`[craftbook:${spec.craftbookId}] installed ${toolsetId} toolset for ${projectId}`);
  }
}

async function ensureWorker(ctx: EvalContext, spec: CraftbookEvalSpec): Promise<string | null> {
  const worker =
    spec.setup?.worker ??
    (spec.runAsCraftbookTask
      ? {
          name: 'Craftbook Runner',
          role: 'Workflow Operator',
          description: 'Executes the assigned craftbook task end to end.',
          about:
            'Follow the assigned craftbook task through its real steps and gates. Use task notes for phase handoffs, advance only after satisfying the active gate, and continue until a terminal step is active or the task is complete.',
        }
      : undefined);
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
  const request = spec.prompt?.trim();
  return `${base} Run this craftbook end to end in this project until the deterministic eval deliverables exist.${request ? ` User request: ${request}` : ''}`;
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
  const craftbookParams: Record<string, string> = {
    ...(spec.setup?.craftbookParams ?? {}),
  };
  if (spec.success.deliverables?.[0]?.path && craftbookParams.outputPath === undefined) {
    craftbookParams.outputPath = spec.success.deliverables[0].path;
  }
  const task = await ctx.client.createTask(projectId, {
    title: spec.title,
    description: craftbookTaskDescription(spec),
    craftbookId: spec.craftbookId,
    ...(Object.keys(craftbookParams).length > 0 ? { craftbookParams } : {}),
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

async function ensureCraftbookTaskToolsetsForWorker(
  client: GezelClient,
  workerId: string,
): Promise<void> {
  for (const id of CRAFTBOOK_TASK_EVAL_TOOLSET_IDS) {
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
  if (spec.success.taskGraph?.requireTerminalStep && matching.length > 0) {
    const reachedTerminal = matching.some((task) => {
      if (task.status === 'complete') return true;
      const active = task.craftbook.steps.find((step) => step.id === task.activeStepId);
      return active?.terminal === true;
    });
    if (!reachedTerminal) {
      failures.push(
        `task sourced from craftbook ${spec.craftbookId} has not reached a terminal step`,
      );
    }
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
      if (isEvalOnlyCheck(check)) {
        evalChecks.push(check);
      } else {
        coreChecks.push(check as GateCheck);
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
    const gateChecks = deliverable.artifact
      ? (gate.checks ?? [])
          .filter((check) =>
            [
              'minBytes',
              'sniff',
              'contains',
              'notContains',
              'tableShape',
              'recordSchema',
              'citationsResolve',
              'valueGrounding',
              'valuesSubsetOf',
              'judge',
              'planStructure',
            ].includes(check.kind),
          )
          .map((check) => ({ ...check, artifact: true }) as GateCheck)
      : (gate.checks ?? []);
    checks.push(...gateChecks);
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

export async function evaluateHistoryExpectations(
  client: GezelClient,
  projectId: string,
  expectations: NonNullable<CraftbookEvalSpec['success']['history']>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const expectation of expectations) {
    const { entries } = await client.listHistory({
      projectId,
      kind: expectation.kind,
      limit: 1_000,
    });
    const matching = entries.filter((entry) => {
      if (entry.entryType !== 'event' || entry.kind !== expectation.kind) return false;
      if (expectation.summaryPattern) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(expectation.summaryPattern, expectation.flags);
        } catch {
          return false;
        }
        if (!pattern.test(entry.summary)) return false;
      }
      return Object.entries(expectation.details ?? {}).every(
        ([key, value]) => entry.details?.[key] === value,
      );
    });
    const required = expectation.minEntries ?? 1;
    if (matching.length < required) {
      const detailText = Object.entries(expectation.details ?? {})
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(', ');
      failures.push(
        `history ${expectation.kind} matched ${matching.length}/${required}${detailText ? ` (${detailText})` : ''}`,
      );
    }
    if (expectation.maxEntries !== undefined && matching.length > expectation.maxEntries) {
      failures.push(
        `history ${expectation.kind} matched ${matching.length}; expected at most ${expectation.maxEntries}`,
      );
    }
  }
  return failures;
}

async function evaluateUnchangedFixtures(
  workspace: CraftbookEvalWorkspace,
  spec: CraftbookEvalSpec,
  substitute: (value: string) => string,
): Promise<string[]> {
  const failures: string[] = [];
  const fixtures = new Map(
    (spec.setup?.files ?? [])
      .filter((file) => file.surface === undefined || file.surface === 'workspace')
      .map((file) => [file.path, substitute(file.content)]),
  );
  for (const path of spec.success.unchangedFixtures ?? []) {
    const expected = fixtures.get(path);
    const actual = await workspace.read(path);
    if (expected === undefined) {
      failures.push(`unchanged fixture ${path} is not defined in setup.files`);
    } else if (actual === null) {
      failures.push(`unchanged fixture ${path} was deleted`);
    } else if (actual !== expected) {
      failures.push(`unchanged fixture ${path} differs from its seeded content`);
    }
  }
  return failures;
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
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.progressTimeoutMs !== undefined ? { progressTimeoutMs: spec.progressTimeoutMs } : {}),
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
    skipInitialPrompt: !!spec.setup?.worker || !!spec.runAsCraftbookTask,
    async setup(ctx) {
      const projectId = await ensureProject(ctx, spec);
      if (projectId) await writeFixtureFiles(ctx, projectId, spec);
      if (projectId && ctx.mocks) await setupMockServices(ctx, projectId, spec);
      if (projectId && ctx.mocks) await installMockMcpToolsets(ctx, spec, projectId);
      if (projectId) await applyProjectWritePolicy(ctx, projectId, spec);
      if (projectId && (spec.setup?.worker || spec.runAsCraftbookTask)) {
        const workerId = await ensureWorker(ctx, spec);
        if (!workerId) return;
        if (directWorkerNeedsWorkspaceToolsets(spec)) {
          await ensureWorkspaceToolsetsForWorker(ctx.client, workerId);
          ctx.log(
            `[craftbook:${spec.craftbookId}] installed workspace eval toolsets for ${workerId}`,
          );
        }
        // Installing any per-gezel builtin group creates an explicit group
        // override, so a worker outfitted with workspace tools no longer
        // inherits its role's tasks/artifacts groups. A real craftbook task
        // needs both surfaces: task notes/advancement plus intermediate
        // artifact handoffs between specialist phases.
        if (spec.runAsCraftbookTask) {
          await ensureCraftbookTaskToolsetsForWorker(ctx.client, workerId);
          ctx.log(
            `[craftbook:${spec.craftbookId}] installed task + artifact eval toolsets for ${workerId}`,
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
            `[craftbook:${spec.craftbookId}] sent kickoff to ${spec.setup?.worker?.name ?? 'Craftbook Runner'} in project ${projectId}`,
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
      const primaryText = primaryDeliverable
        ? await readDeliverable(workspace, primaryDeliverable)
        : null;
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
      const virtualFiles = new Map<string, string>(
        (spec.setup?.files ?? [])
          .filter((file) => file.surface === 'harness')
          .map((file) => [
            file.path,
            ctx.mocks ? ctx.mocks.substitute(file.content) : file.content,
          ]),
      );
      if (spec.success.taskNotes) {
        taskNotes = await taskNotesTextForSpec(ctx.client, projectId, spec);
        virtualFiles.set('task-notes.md', taskNotes.text);
      }
      if (spec.success.taskGraph) {
        taskGraph = await taskGraphTextForSpec(ctx.client, projectId, spec);
        virtualFiles.set('task-graph.md', taskGraph.text);
      }
      if (virtualFiles.size > 0) {
        gateWorkspace = {
          ...workspace,
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
      if (spec.success.history && spec.success.history.length > 0) {
        failures.push(
          ...(await evaluateHistoryExpectations(ctx.client, projectId, spec.success.history)),
        );
      }
      failures.push(
        ...(await evaluateUnchangedFixtures(
          workspace,
          spec,
          ctx.mocks ? (value) => ctx.mocks!.substitute(value) : (value) => value,
        )),
      );
      const unreadSeededPaths = await missingSeededReads(ctx.client, projectId, spec);
      if (unreadSeededPaths.length > 0) {
        failures.unshift(
          `seeded workspace input(s) have not been read yet: ${unreadSeededPaths.join(', ')}`,
        );
      }
      const repairFailures = prioritizeRepairFailures(failures);
      const taskGraphRequirementCount =
        Number(spec.success.taskGraph?.requireCraftbookTask === true) +
        Number(spec.success.taskGraph?.requireTerminalStep === true) +
        Number(spec.success.taskGraph?.requireDraftRef === true) +
        Object.values(spec.success.taskGraph?.draft ?? {}).filter((value) => value !== undefined)
          .length;
      const checkCount =
        checks.length +
        (spec.success.history?.length ?? 0) +
        (spec.success.unchangedFixtures?.length ?? 0) +
        Number(spec.success.taskNotes?.requireCraftbookTask === true) +
        taskGraphRequirementCount;
      const passed = Math.max(0, checkCount - failures.length);
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
        `[scenario] ${spec.scenarioId} bytes=${sniffBytes} checks=${passed}/${checkCount} failures=${failures.join(' | ') || 'none'}`,
      );

      if (failures.length === 0) {
        noWriteRepairState = null;
        return {
          done: true,
          success: true,
          reason: `${spec.scenarioId} passed ${checkCount} deterministic craftbook checks`,
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
            ? await readDeliverable(workspace, repairDeliverable)
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
          repairDirective: repairDeliverable
            ? craftbookExistingDeliverableRepairDirective(repairDeliverable.path)
            : undefined,
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
