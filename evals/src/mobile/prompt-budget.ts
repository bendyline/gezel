import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CreateGezelRequest, CreateProjectRequest } from '@bendyline/gezel';
import {
  type PortableContent,
  type PortableFileSystem,
  type PortableInference,
  PortableProductService,
  type PortableScripts,
  PortableStore,
} from '@bendyline/gezel/runtime';
import { canonicalMobileFixtures } from './fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const marker = 'Recording-only prompt audit: no model inference was executed';
type CapturedRequest = Parameters<PortableInference['generate']>[0];
interface AuditCase {
  id: string;
  project?: CreateProjectRequest;
  gezel?: CreateGezelRequest;
  files?: Array<{ path: string; content: string }>;
  prompt: string;
  task?: boolean;
}

/** Uses the production mobile content plugin and PortableProductService assembler.
 * Its inference port records the request then throws, so this cannot yield a quality score. */
export async function auditMobilePromptBudgets() {
  const testFilesUrl = pathToFileURL(resolve(root, 'packages/core/src/runtime/test-files.ts')).href;
  const { MemoryFiles } = (await import(testFilesUrl)) as {
    MemoryFiles: new () => PortableFileSystem;
  };
  const contentUrl = pathToFileURL(
    resolve(root, 'packages/mobile/scripts/portable-content.ts'),
  ).href;
  const contentModule = (await import(contentUrl)) as {
    portableContentPlugin(): { load(id: string): Promise<string> };
  };
  const serialized = await contentModule
    .portableContentPlugin()
    .load('\0virtual:gezel-portable-content');
  const content = JSON.parse(
    serialized.replace(/^export default /, '').replace(/;$/, ''),
  ) as PortableContent;
  const cases: AuditCase[] = [
    { id: 'default-meester', prompt: 'Help me organize a useful report for my project.' },
    {
      id: 'recruited-generalist',
      gezel: { name: 'Audit companion', role: 'Generalist' },
      prompt: 'Read the project files and prepare a concise report in the artifacts.',
    },
    ...(await canonicalMobileFixtures()).map((fixture) => ({
      id: `canonical:${fixture.id}`,
      project: fixture.project,
      gezel: fixture.gezel,
      files: fixture.files,
      prompt: fixture.prompts[0]!,
    })),
    {
      id: 'active-gated-task',
      gezel: { name: 'Audit companion', role: 'Generalist' },
      task: true,
      prompt:
        'Work on the active task step. Save the deliverable and check its completion gate before advancing.',
    },
  ];
  const results = [];
  for (const entry of cases) {
    let id = 0;
    const store = new PortableStore({ files: new MemoryFiles(), createId: () => `budget-${++id}` });
    const captured: CapturedRequest[] = [];
    const inference: PortableInference = {
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Recording-only port',
          locality: 'on-device',
          availability: 'available',
          contextTokens: 8192,
          maxOutputTokens: 1024,
          capabilities: {
            text: true,
            tools: false,
            structuredOutput: false,
            images: false,
            foregroundOnly: true,
          },
        },
      ],
      generate: async (request) => {
        captured.push(structuredClone(request));
        throw new Error(marker);
      },
      cancel: async () => {},
    };
    const scripts: PortableScripts = {
      list: () => [],
      source: async () => {
        throw new Error(marker);
      },
      run: async () => {
        throw new Error(marker);
      },
      initialize: async () => {},
      isBusy: () => false,
      cancel: async () => {},
    };
    const service = new PortableProductService(store, inference, 'budget-audit');
    service.setScripts(scripts);
    service.setContent(content);
    await service.initialize();
    await store.writeConfig({
      provider: 'llama-cpp',
      modelContextOverrides: { 'llama-cpp:llama-cpp': 4096 },
      modelTuning: { 'llama-cpp': { sampling: { maxTokens: 1024 } } },
    });
    const request = async (path: string, body?: unknown) => {
      const response = await service.fetch(`https://gezel.local/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer budget-audit', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const settle = async () => {
      for (let index = 0; index < 1000 && service.busy; index++)
        await new Promise((done) => setTimeout(done, 1));
      if (service.busy) throw new Error('Recording-only service did not settle');
    };
    const projectId = entry.project
      ? String((await request('projects', entry.project)).body.id)
      : 'default';
    const gezelId = entry.gezel
      ? String((await request('gezels', entry.gezel)).body.id)
      : (await store.readConfig()).meesterGezelId!;
    if (entry.gezel) await request(`projects/${projectId}/gezels`, { gezelId });
    for (const file of entry.files ?? [])
      await store.writeFile('workspace', projectId, file.path, file.content);
    let taskRef: string | undefined;
    let stepId: string | undefined;
    if (entry.task) {
      const task = await store.createTask(projectId, {
        title: 'Prepare repair handover',
        description:
          'Create a repair handover artifact recording who owns the repair cabinet and its opening time.',
        status: 'draft',
        assignee: { kind: 'gezel', gezelId },
        steps: [
          {
            id: 'write',
            name: 'Write handover',
            prompt:
              'Write handover.md in the artifacts: Noor owns the repair cabinet and opens it at 09:30 on Monday. Then complete this task step.',
            terminal: true,
            gate: {
              at: 'completion',
              checks: [
                { kind: 'minBytes', file: 'handover.md', artifact: true, bytes: 40 },
                { kind: 'sniff', file: 'handover.md', artifact: true, sniff: 'nonempty' },
              ],
            },
          },
        ],
      });
      await store.setTaskStatus(task.ref, 'active');
      taskRef = task.ref;
      stepId = task.activeStepId;
    }
    const session = await store.createSession({
      gezelId,
      projectId,
      providerName: 'llama-cpp',
      taskRef,
      stepId,
    });
    const admission = await request(`sessions/${session.id}/send`, { message: entry.prompt });
    await settle();
    const reachedAtTarget = captured.length > 0;
    if (!reachedAtTarget) {
      // Inspection only: retain the failed 4096 admission, then ask the same
      // production assembler for the exact unchanged message at a larger ceiling.
      await store.writeConfig({ modelContextOverrides: { 'llama-cpp:llama-cpp': 8192 } });
      await request(`sessions/${session.id}/send`, { message: entry.prompt });
      await settle();
    }
    const assembled = captured.at(-1);
    const system = assembled?.messages.find((message) => message.role === 'system')?.content ?? '';
    const bytes = (value: string) => new TextEncoder().encode(value).length;
    // The listing starts where the prompt footprint says: JSON schemas at
    // `full`, one line per tool at `compact` and `signatures`.
    const toolsAt = system.indexOf('## Tools available this turn');
    const toolsText = toolsAt < 0 ? '' : system.slice(toolsAt);
    const jsonAt = toolsText.lastIndexOf('\n[');
    let inventory: Array<{ name: string; bytes: number }> = [];
    if (jsonAt >= 0) {
      try {
        inventory = (JSON.parse(toolsText.slice(jsonAt + 1)) as Array<{ name: string }>).map(
          (tool) => ({ name: tool.name, bytes: bytes(JSON.stringify(tool)) }),
        );
      } catch {}
    } else {
      inventory = toolsText
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => ({ name: line.slice(2, line.indexOf('(')), bytes: bytes(line) }));
    }
    results.push({
      id: entry.id,
      recordingOnly: true,
      targetContextTokens: 4096,
      targetReplyTokens: 1024,
      historicalByteHeuristic: 9216,
      transportByteLimit: 256 * 1024,
      transportMessageLimit: 128,
      targetAdmission: {
        status: admission.status,
        reachedInferencePort: reachedAtTarget,
        ...(reachedAtTarget ? {} : { error: admission.body.error }),
      },
      totalPromptBytes:
        assembled?.messages.reduce((sum, message) => sum + bytes(message.content), 0) ?? null,
      systemBytes: bytes(system),
      toolListing: jsonAt >= 0 ? 'full' : inventory.length ? 'lines' : 'none',
      toolInventoryBytes: inventory.length ? bytes(toolsText) : null,
      toolCount: inventory.length,
      tools: inventory.sort((a, b) => b.bytes - a.bytes),
      exactMessages: assembled?.messages ?? [],
      probeContextTokens: assembled?.contextSize,
      aboutBytes: bytes((await store.getGezel(gezelId))?.about ?? ''),
    });
    await service.suspend();
  }
  return {
    kind: 'mobile-production-prompt-budget-audit',
    recordingOnly: true,
    generatedModelResponses: 0,
    at: new Date().toISOString(),
    templates: content.templates.length,
    notes: [
      'Exact production assembly and pinned mobile catalog content; in-memory filesystem only.',
      'The inference port records and throws. No native model or tokenizer was run.',
      'The historical 9216-byte estimate is diagnostic only. Current host transport limits are 256 KiB/128 messages; native tokenizers decide whether the requested 4096/1024 fits.',
      'A rejected 4096 request may be reassembled at 8192 only to expose its exact bytes; its target admission remains failed.',
      'Scripts are marked installed to retain the real tool inventory; no script runs or outputs are fabricated.',
    ],
    results,
  };
}

interface TypedCase {
  id: string;
  typeId: string;
  params?: Record<string, unknown>;
  prompt: string;
}

/**
 * Project-type sessions (the activities) as a phone assembles them, on both
 * of its loops: the shared llama.cpp loop, recorded from the OpenAI-shaped
 * request it hands the engine, and a system model's text loop. The pass line
 * is the engagement plan's: the system prompt and the tools a turn carries
 * take at most half the window, leaving the rest for the conversation and the
 * reply. Recording only, like the audit above.
 */
export async function auditProjectTypePromptBudgets(windows: readonly number[] = [4096, 8192]) {
  const testFilesUrl = pathToFileURL(resolve(root, 'packages/core/src/runtime/test-files.ts')).href;
  const { MemoryFiles } = (await import(testFilesUrl)) as {
    MemoryFiles: new () => PortableFileSystem;
  };
  const contentUrl = pathToFileURL(
    resolve(root, 'packages/mobile/scripts/portable-content.ts'),
  ).href;
  const plugin = (
    (await import(contentUrl)) as { portableContentPlugin(): { load(id: string): Promise<string> } }
  ).portableContentPlugin();
  const parse = (serialized: string) =>
    JSON.parse(serialized.replace(/^export default /, '').replace(/;$/, ''));
  const content = parse(await plugin.load('\0virtual:gezel-portable-content')) as PortableContent;
  const types = parse(await plugin.load('\0virtual:gezel-portable-project-types')) as unknown[];
  const cases: TypedCase[] = [
    { id: 'checkers', typeId: 'checkers', prompt: 'It is your move.' },
    { id: 'language-trainer', typeId: 'language-trainer', prompt: 'Hola, quiero practicar hoy.' },
    { id: 'fitness-coach', typeId: 'fitness-coach', prompt: 'I ran 5 km in 28 minutes today.' },
    { id: 'just-chat', typeId: 'just-chat', prompt: 'Hi! Long day today.' },
  ];
  const providers = [
    { id: 'llama-cpp' as const, structuredChat: true },
    { id: 'android-mlkit' as const, structuredChat: false },
  ];
  const results = [];
  for (const provider of providers)
    for (const window of windows)
      for (const entry of cases) {
        let id = 0;
        const store = new PortableStore({
          files: new MemoryFiles(),
          createId: () => `typed-${++id}`,
        });
        const recorded: Array<{ system: string; tools: string; user: string }> = [];
        const record = (messages: Array<{ role: string; content: unknown }>, tools: unknown) => {
          const text = (role: string) =>
            messages
              .filter((message) => message.role === role)
              .map((message) =>
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join('\n');
          recorded.push({
            system: text('system'),
            tools: tools ? JSON.stringify(tools) : '',
            user: messages.at(-1)?.role === 'user' ? (text('user').split('\n').at(-1) ?? '') : '',
          });
        };
        const inference: PortableInference = {
          providers: async () => [
            {
              id: provider.id,
              name: 'Recording-only port',
              locality: 'on-device',
              availability: 'available',
              contextTokens: window,
              maxOutputTokens: 1024,
              capabilities: {
                text: true,
                tools: false,
                structuredOutput: false,
                images: false,
                foregroundOnly: true,
                ...(provider.structuredChat ? { structuredChat: true } : {}),
              },
            },
          ],
          generate: async (request) => {
            record(request.messages, undefined);
            throw new Error(marker);
          },
          ...(provider.structuredChat
            ? {
                chat: async (request: { body: Record<string, unknown> }) => {
                  record(
                    request.body.messages as Array<{ role: string; content: unknown }>,
                    request.body.tools,
                  );
                  throw new Error(marker);
                },
              }
            : {}),
          cancel: async () => {},
        } as PortableInference;
        const scripts: PortableScripts = {
          list: () => [],
          source: async () => {
            throw new Error(marker);
          },
          run: async () => {
            throw new Error(marker);
          },
          initialize: async () => {},
          isBusy: () => false,
          cancel: async () => {},
        };
        const service = new PortableProductService(store, inference, 'budget-audit', {
          projectTypes: async () => types as never,
        });
        service.setScripts(scripts);
        service.setContent(content);
        await service.initialize();
        await store.writeConfig({
          provider: provider.id,
          modelContextOverrides: { [`${provider.id}:${provider.id}`]: window },
        });
        const call = async (path: string, body?: unknown) => {
          const response = await service.fetch(`https://gezel.local/api/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: 'Bearer budget-audit', 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return (await response.json()) as Record<string, unknown>;
        };
        const created = (await call('projects/typed', {
          name: `Audit ${entry.id}`,
          projectType: { typeId: entry.typeId, ...(entry.params ? { params: entry.params } : {}) },
        })) as { project?: { id: string; voormanGezelId?: string; gezelIds?: string[] } };
        const project = created.project;
        if (!project)
          throw new Error(`${entry.id}: the type did not apply (${JSON.stringify(created)})`);
        const gezelId = project.voormanGezelId ?? project.gezelIds?.[0];
        const session = await store.createSession({
          gezelId: gezelId!,
          projectId: project.id,
          providerName: provider.id,
        });
        await call(`sessions/${session.id}/send`, { message: entry.prompt });
        for (let index = 0; index < 2000 && service.busy; index++)
          await new Promise((done) => setTimeout(done, 1));
        await service.suspend();
        const first = recorded[0];
        const tokens = (value: string) => Math.ceil(value.length / 4);
        const systemTokens = first ? tokens(first.system) : null;
        const toolTokens = first ? tokens(first.tools) : null;
        const standing = (systemTokens ?? 0) + (toolTokens ?? 0);
        results.push({
          id: `${provider.id}:${window}:${entry.id}`,
          reachedInferencePort: recorded.length > 0,
          systemTokens,
          toolTokens,
          standingTokens: first ? standing : null,
          userTokens: first ? tokens(first.user) : null,
          budgetTokens: window / 2,
          withinBudget: !!first && standing <= window / 2,
          exactSystem: first?.system ?? '',
        });
      }
  return {
    kind: 'project-type-prompt-budget-audit',
    recordingOnly: true,
    at: new Date().toISOString(),
    note: 'Tokens are estimated at four characters each; no tokenizer ran.',
    results,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes('--project-types')
) {
  const output = resolve(
    process.argv.find((arg) => arg.endsWith('.json')) ??
      '/tmp/gezel-project-type-prompt-budget.json',
  );
  const report = await auditProjectTypePromptBudgets();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      report.results.map(({ exactSystem, ...summary }) => summary),
      null,
      2,
    ),
  );
  process.exitCode = report.results.every((result) => result.withinBudget) ? 0 : 1;
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] ?? '/tmp/gezel-mobile-prompt-budget.json');
  const report = await auditMobilePromptBudgets();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      report.results.map(({ exactMessages, tools, ...summary }) => summary),
      null,
      2,
    ),
  );
  process.exitCode = report.results.every((result) => result.targetAdmission.reachedInferencePort)
    ? 0
    : 1;
}
