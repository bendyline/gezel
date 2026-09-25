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
    const inventoryText = system.slice(system.lastIndexOf('\n[') + 1);
    let inventory: Array<{ name: string }> = [];
    try {
      inventory = JSON.parse(inventoryText);
    } catch {}
    const bytes = (value: string) => new TextEncoder().encode(value).length;
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
      toolInventoryBytes: inventory.length ? bytes(inventoryText) : null,
      toolCount: inventory.length,
      tools: inventory
        .map((tool) => ({ name: tool.name, bytes: bytes(JSON.stringify(tool)) }))
        .sort((a, b) => b.bytes - a.bytes),
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
