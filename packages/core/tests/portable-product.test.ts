import { describe, expect, it } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { poppetjeFromSeed } from '../src/poppetje/seed.js';
import type { PortableFileEntry, PortableFileSystem } from '../src/runtime/files.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { PortableStore } from '../src/runtime/store.js';
import { CatalogItemDetailSchema } from '../src/schemas/catalog.js';
import { ListTimelineResponseSchema } from '../src/schemas/session.js';

class MemoryFiles implements PortableFileSystem {
  entries = new Map<string, Uint8Array | null>([['', null]]);
  failWrites = false;
  failWrite: ((path: string) => boolean) | undefined;
  async read(path: string) {
    const value = this.entries.get(path);
    return value ? value.slice() : null;
  }
  async mkdir(path: string) {
    for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') {
      if (this.entries.get(p) instanceof Uint8Array) throw new Error('File is not a directory');
      this.entries.set(p, null);
    }
  }
  async write(path: string, data: Uint8Array) {
    if (this.failWrites || this.failWrite?.(path)) throw new Error('Disk full');
    const slash = path.lastIndexOf('/');
    if (slash > 0) await this.mkdir(path.slice(0, slash));
    this.entries.set(path, data.slice());
  }
  async list(path: string) {
    const prefix = path ? `${path}/` : '';
    return [...this.entries]
      .filter(
        ([name]) =>
          name !== path && name.startsWith(prefix) && !name.slice(prefix.length).includes('/'),
      )
      .map(
        ([name, data]): PortableFileEntry => ({
          name: name.slice(prefix.length),
          isDirectory: data === null,
          size: data?.length ?? 0,
          mtime: Date.now(),
        }),
      );
  }
  async remove(path: string) {
    for (const name of this.entries.keys())
      if (name === path || name.startsWith(`${path}/`)) this.entries.delete(name);
  }
  async rename(from: string, to: string) {
    if (this.entries.has(to)) throw new Error('Exists');
    const values = [...this.entries].filter(
      ([name]) => name === from || name.startsWith(`${from}/`),
    );
    if (!values.length) throw new Error('Missing');
    for (const [name, data] of values) this.entries.set(to + name.slice(from.length), data);
    await this.remove(from);
  }
}
function provider(): Awaited<ReturnType<PortableInference['providers']>> {
  return [
    {
      id: 'llama-cpp',
      name: 'Test local model',
      locality: 'on-device',
      availability: 'available',
      contextTokens: 32000,
      maxOutputTokens: 1000,
      capabilities: {
        text: true,
        tools: false,
        structuredOutput: false,
        images: false,
        foregroundOnly: true,
      },
    },
  ];
}
async function setup(inference?: Partial<PortableInference>, files = new MemoryFiles()) {
  const store = new PortableStore({ files });
  const seen: string[] = [];
  const service = new PortableProductService(
    store,
    {
      providers: async () => provider(),
      generate: async (request, onDelta) => {
        seen.push(JSON.stringify(request.messages));
        onDelta({ requestId: request.requestId, delta: 'A useful answer' });
        return { text: 'A useful answer', stopReason: 'stop' };
      },
      cancel: async () => {},
      ...inference,
    },
    'test-token',
  );
  await service.initialize();
  const client = new GezelClient({
    baseUrl: 'https://gezel.local',
    token: 'test-token',
    fetch: service.fetch,
  });
  return { store, service, client, files, seen };
}
async function settled(service: PortableProductService) {
  for (let i = 0; i < 100 && service.busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(service.busy).toBe(false);
}

describe('ordinary client against offline product runtime', () => {
  it('saves, reopens, duplicates and sends task-composer drafts through the shared client', async () => {
    const { client, store, service, files, seen } = await setup();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const task = await store.createTask('default', {
      title: 'Offline draft',
      description: 'Keep the task message until it is ready.',
      steps: [{ name: 'Prepare', terminal: true }],
    });
    const session = await client.createChatSession({
      gezelId,
      projectId: 'default',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    const draft = await client.createPromptDraft('default', {
      gezelId,
      taskRef: task.ref,
      sessionId: session.id,
      scope: 'task',
      content: 'Please use the saved project brief.',
    });
    await service.suspend();
    const reopened = await setup(undefined, files);
    const saved = await reopened.client.getPromptDraft('default', draft.id);
    expect(saved).toMatchObject({ taskRef: task.ref, scope: 'task', content: draft.content });
    const copy = await reopened.client.duplicatePromptDraft('default', draft.id, {
      sessionId: null,
    });
    expect(copy).toMatchObject({ taskRef: task.ref, scope: 'task', sessionId: null });
    expect(
      await reopened.client.sendToChatSession(session.id, {
        message: saved.content,
        draftId: saved.id,
      }),
    ).toMatchObject({ accepted: true });
    await settled(reopened.service);
    expect((await reopened.client.getPromptDraft('default', draft.id)).status).toBe('sent');
    expect(reopened.seen).toHaveLength(1);
    expect(seen).toHaveLength(0);
    const transcript = (await reopened.client.getChatSession(session.id)).messages;
    await reopened.service.suspend();
    const afterSend = await setup(undefined, files);
    expect((await afterSend.client.getChatSession(session.id)).messages).toEqual(transcript);
    expect((await afterSend.client.getPromptDraft('default', draft.id)).status).toBe('sent');
    await afterSend.service.suspend();
  });
  it('rejects cross-task draft addresses without consuming drafts or blocking future work', async () => {
    const { client, store, service, seen } = await setup();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const task = await store.createTask('default', {
      title: 'Scoped draft',
      description: 'Keep this draft associated with its original task context.',
      steps: [{ name: 'Prepare' }],
    });
    const draft = await client.createPromptDraft('default', {
      gezelId,
      taskRef: task.ref,
      content: 'For this task only.',
    });
    const unrelated = await client.createChatSession({ gezelId });
    await expect(
      client.patchPromptDraft('default', draft.id, { sessionId: unrelated.id }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.sendToChatSession(unrelated.id, { message: draft.content, draftId: draft.id }),
    ).rejects.toMatchObject({ status: 409 });
    expect(service.getStatus().pendingSave).toBe(false);
    expect((await client.getPromptDraft('default', draft.id)).status).toBe('draft');
    expect((await client.getChatSession(unrelated.id)).messages).toHaveLength(0);
    expect(seen).toHaveLength(0);
    const another = await client.createProject({ name: 'Another project' });
    await expect(
      client.createPromptDraft(another.id, { gezelId, taskRef: task.ref }),
    ).rejects.toMatchObject({ status: 400 });
    await client.sendToChatSession(unrelated.id, { message: 'An ordinary message still works.' });
    await settled(service);
    expect(seen).toHaveLength(1);
    await service.suspend();
  });
  it.each([false, true])(
    'reports the actual product version and verified host preview availability (%s)',
    async (htmlPreview) => {
      const { service: original } = await setup();
      const store = new PortableStore({ files: new MemoryFiles(), version: '1.2.3' });
      const service = new PortableProductService(store, original.inference, 'test-token', {
        htmlPreview,
      });
      await service.initialize();
      const client = new GezelClient({
        baseUrl: 'https://gezel.local',
        token: 'test-token',
        fetch: service.fetch,
      });
      const health = await client.health();
      expect(health).toMatchObject({
        version: '1.2.3',
        capabilities: { htmlPreview, terminal: false, scripts: true },
      });
      expect(Object.isFrozen(service.capabilities)).toBe(true);
    },
  );

  it('creates ordinary role-based gezels from the same curated template, preserving explicit about text', async () => {
    const { store, service, client, files } = await setup();
    const template = CatalogItemDetailSchema.parse({
      sourceId: 'bundled',
      kind: 'gezel-template',
      about: 'Curated research practice with evidence and citations.',
      manifest: {
        schemaVersion: 1,
        kind: 'gezel-template',
        id: 'researcher',
        name: 'Researcher',
        role: 'Researcher',
        description: 'Researches evidence',
        version: '1.0.0',
        releasedAt: '2026-09-20',
        tags: [],
        maintainer: { name: 'Gezel' },
        about: 'about.md',
        suggestedTools: [],
        frontmatter: { suggestedTuningProfile: 'thinking-precise' },
      },
    });
    service.setContent({ templates: [template], craftbooks: [] });
    const created = await client.createGezel({ name: 'Noor', role: 'Researcher' });
    expect(created.about).toBe(template.about);
    expect(created.parsed.frontmatter).toMatchObject({
      name: 'Noor',
      role: 'Researcher',
      templateId: 'researcher',
      templateVersion: '1.0.0',
      suggestedTuningProfile: 'thinking-precise',
    });
    const bespoke = await client.createGezel({
      name: 'Anika',
      role: 'Researcher',
      about: 'Use my specific brief.',
    });
    expect(bespoke.about).toBe('Use my specific brief.');
    expect(bespoke.parsed.frontmatter.templateId).toBeUndefined();
    const reopened = await setup(undefined, files);
    expect((await reopened.client.getGezel(created.id)).about).toBe(template.about);
    expect((await store.getGezel(created.id))?.parsed.frontmatter.templateVersion).toBe('1.0.0');
  });
  it('finds local HTML outputs through the ordinary shallow workspace API', async () => {
    const { store, client } = await setup();
    for (const path of [
      'index.html',
      'site/main.htm',
      'site/deep/third/fourth/page.HTML',
      'site/deep/third/fourth/fifth/hidden.html',
      'node_modules/vendor/index.html',
      '.private/index.html',
      'source.ts',
    ])
      await store.writeFile('workspace', 'default', path, '<!doctype html>');
    const result = await client.listProjectWorkspaceHtmlPages('default');
    expect(result.files.map((file) => file.path)).toEqual([
      'index.html',
      'site/main.htm',
      'site/deep/third/fourth/page.HTML',
    ]);
    await expect(client.listProjectWorkspaceHtmlPages('missing')).rejects.toMatchObject({
      status: 404,
    });
  });
  it('edits and rerolls the shared appearance API without changing persisted grain identity', async () => {
    const { client, files } = await setup();
    const gezel = await client.createGezel({ name: 'Noor', role: 'Writer', gender: 'female' });
    const { poppetje: initial } = await client.getGezelPoppetje(gezel.id);
    const { poppetje: custom } = await client.setGezelPoppetje(gezel.id, {
      poppetje: { ...initial, key: 'another-person', shirt: '#123456' },
    });
    expect(custom).toMatchObject({ key: gezel.id, shirt: '#123456' });
    const reopened = await setup(undefined, files);
    expect((await reopened.client.getGezelPoppetje(gezel.id)).poppetje).toEqual(custom);
    const { poppetje: rerolled } = await reopened.client.rerollGezelPoppetje(gezel.id, {
      seed: 318,
    });
    expect(rerolled).toEqual(
      poppetjeFromSeed(318, { key: gezel.id, name: 'Noor', gender: 'female' }),
    );
    expect(
      JSON.parse(new TextDecoder().decode((await files.read(`gezels/${gezel.id}/poppetje.json`))!)),
    ).toEqual(rerolled);
    await expect(reopened.client.rerollGezelPoppetje(gezel.id, { seed: 0.5 })).rejects.toThrow();
    expect((await reopened.client.getGezelPoppetje(gezel.id)).poppetje).toEqual(rerolled);
    const restarted = await setup(undefined, files);
    expect((await restarted.client.getGezel(gezel.id)).poppetje).toEqual(rerolled);
  });

  it('publishes entity and draft lifecycle events through the shared global event contract', async () => {
    const { client, service } = await setup();
    const response = await service.fetch('https://gezel.local/events/chat/all', {
      headers: { authorization: 'Bearer test-token' },
    });
    const reader = response.body!.getReader();
    const event = async () => {
      const chunk = new TextDecoder().decode((await reader.read()).value);
      return JSON.parse(chunk.slice('data: '.length)).event;
    };
    await reader.read();
    try {
      const gezel = await client.createGezel({ name: 'Noor' });
      expect(await event()).toMatchObject({ type: 'gezel_created', gezelId: gezel.id });
      const project = await client.createProject({ name: 'Field notes' });
      expect(await event()).toMatchObject({ type: 'project_created', projectId: project.id });
      const draft = await client.createPromptDraft(project.id, {
        gezelId: gezel.id,
        content: 'First draft',
      });
      expect(await event()).toMatchObject({
        type: 'prompt_draft_changed',
        draftId: draft.id,
        status: 'draft',
      });
      await client.writePromptDraftContent(project.id, draft.id, 'Revised draft');
      expect(await event()).toMatchObject({ type: 'prompt_draft_changed', draftId: draft.id });
      expect(await client.deletePromptDraft(project.id, draft.id)).toEqual({
        ok: true,
        deleted: true,
      });
      expect(await event()).toMatchObject({ type: 'prompt_draft_changed', deleted: true });
    } finally {
      await reader.cancel();
    }
  });
  it('replays an in-flight native reply when a shared timeline reconnects', async () => {
    let finish!: (value: { text: string; stopReason: 'stop' }) => void;
    const { client, service } = await setup({
      generate: (request, onDelta) => {
        onDelta({ requestId: request.requestId, delta: 'Visible partial reply' });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    await client.sendToChatSession(session.id, { message: 'Continue after navigation' });
    for (let i = 0; i < 100 && !finish; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(finish).toBeDefined();
    const stream = await service.fetch(client.projectEventsUrl('default'), {
      headers: { authorization: 'Bearer test-token' },
    });
    const reader = stream.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      const second = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('user_message');
      expect(second).toContain('Visible partial reply');
    } finally {
      await reader.cancel();
      finish({ text: 'Visible partial reply', stopReason: 'stop' });
      await settled(service);
    }
    const completed = await service.fetch(client.projectEventsUrl('default'), {
      headers: { authorization: 'Bearer test-token' },
    });
    const doneReader = completed.body!.getReader();
    expect(new TextDecoder().decode((await doneReader.read()).value)).toBe(': connected\n\n');
    await doneReader.cancel();
  });
  it('creates crew/project/documents, streams a contextual reply, saves output and reopens the same files', async () => {
    const { client, service, files, seen } = await setup();
    const gezel = await client.createGezel({
      name: 'Anika',
      role: 'Writer',
      about: 'You write useful drafts.',
    });
    const project = await client.createProject({
      name: 'Garden notes',
      about: 'An accessible neighbourhood garden.',
      missionObjectives: 'A short seasonal plan.',
    });
    await client.addGezelToProject(project.id, gezel.id);
    await client.writeDocument('style.md', 'Use plain language.');
    await client.writeProjectWorkspaceFile(project.id, {
      path: 'brief.md',
      content: 'Plant beans in spring.',
    });
    const session = await client.createChatSession({ gezelId: gezel.id, projectId: project.id });
    const controller = new AbortController();
    const stream = await service.fetch(client.projectEventsUrl(project.id), {
      headers: { authorization: 'Bearer test-token' },
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    await reader.read();
    await client.sendToChatSession(session.id, {
      message: 'Draft a plan using [brief](workspace/brief.md) and [style](documents/style.md).',
    });
    await settled(service);
    const raw = await reader.read();
    expect(new TextDecoder().decode(raw.value)).toContain('user_message');
    controller.abort();
    const saved = await client.getChatSession(session.id);
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(seen[0]).toContain('Plant beans in spring');
    expect(seen[0]).toContain('accessible neighbourhood garden');
    await client.writeProjectArtifact(project.id, 'plan.md', saved.messages[1]!.content);
    const reopened = await setup({}, files);
    expect((await reopened.client.readProjectArtifact(project.id, 'plan.md')).content).toBe(
      'A useful answer',
    );
    expect((await reopened.client.getChatSession(session.id)).messages).toHaveLength(2);
    const timeline = await reopened.client.listProjectTimeline(project.id);
    expect(ListTimelineResponseSchema.safeParse(timeline).success).toBe(true);
    expect([...files.entries.keys()]).toContain(`gezels/${gezel.id}/sessions/${session.id}.json`);
    expect([...files.entries.keys()]).toContain(`projects/${project.id}/project.json`);
    expect([...files.entries.keys()].some((path) => path.includes('mobile-v1'))).toBe(false);
  });
  it('never starts inference when the initial conversation write fails', async () => {
    let generated = false;
    const { client, files } = await setup({
      generate: async () => {
        generated = true;
        return { text: 'no', stopReason: 'stop' };
      },
    });
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    files.failWrites = true;
    await expect(client.sendToChatSession(session.id, { message: 'Hello' })).rejects.toMatchObject({
      details: { error: 'Disk full' },
    });
    expect(generated).toBe(false);
  });

  it('preserves the native token budget and complete prompt when byte heuristics would reject it', async () => {
    let request: Parameters<PortableInference['generate']>[0] | undefined;
    const { service, client } = await setup({
      generate: async (value) => {
        request = value;
        throw new Error('The native tokenizer found that prompt plus output exceeds the context');
      },
    });
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    const message = `Read this complete source: ${'{"item":1},'.repeat(1800)}`;
    await client.sendToChatSession(session.id, { message });
    await settled(service);
    expect(request).toMatchObject({ contextSize: 4096, maxTokens: 1000 });
    expect(request?.messages.at(-1)?.content).toBe(message);
    const saved = await client.getChatSession(session.id);
    expect(saved.messages[0]?.content).toBe(message);
    expect(saved.lastTurnError).toContain('native tokenizer');
    expect(saved.messages.some((item) => item.role === 'assistant')).toBe(false);
  });
  it('retains a completed response on failed final save and blocks mutations until retry succeeds', async () => {
    const files = new MemoryFiles();
    const { service, client } = await setup(
      {
        generate: async () => {
          files.failWrites = true;
          return { text: 'Keep this response', stopReason: 'stop' };
        },
      },
      files,
    );
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    await client.sendToChatSession(session.id, { message: 'Hello' });
    await settled(service);
    expect((await client.getChatSession(session.id)).messages.at(-1)?.content).toBe(
      'Keep this response',
    );
    await expect(client.createProject({ name: 'Blocked' })).rejects.toMatchObject({ status: 507 });
    files.failWrites = false;
    await service.retrySave();
    expect((await client.getChatSession(session.id)).messages.at(-1)?.content).toBe(
      'Keep this response',
    );
  });
  it('recovers a published admission journal and starts its draft turn exactly once', async () => {
    const { client, service, files, seen } = await setup();
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    const draft = await client.createPromptDraft('default', {
      gezelId: session.gezelId,
      sessionId: session.id,
      content: 'Recover this committed message.',
    });
    let failures = 0;
    files.failWrite = (path) => {
      if (
        path === `gezels/${session.gezelId}/sessions/${session.id}.json` &&
        files.entries.has('.transactions/pending.json') &&
        failures === 0
      ) {
        failures++;
        return true;
      }
      return false;
    };
    expect(
      await client.sendToChatSession(session.id, { message: draft.content, draftId: draft.id }),
    ).toMatchObject({ accepted: true });
    await settled(service);
    expect(failures).toBe(1);
    expect(seen).toHaveLength(1);
    expect(
      (await client.getChatSession(session.id)).messages.map((message) => message.role),
    ).toEqual(['user', 'assistant']);
    expect((await client.getPromptDraft('default', draft.id)).status).toBe('sent');
    expect(service.getStatus().pendingSave).toBe(false);
    expect(files.entries.has('.transactions/pending.json')).toBe(false);
  });
  it('retains an interrupted admission when journal recovery stays blocked and never generates on save retry', async () => {
    const { client, service, files, seen } = await setup();
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    const draft = await client.createPromptDraft('default', {
      gezelId: session.gezelId,
      sessionId: session.id,
      content: 'Keep my message even when the disk fails.',
    });
    files.failWrite = (path) =>
      path === `gezels/${session.gezelId}/sessions/${session.id}.json` &&
      files.entries.has('.transactions/pending.json');
    await expect(
      client.sendToChatSession(session.id, { message: draft.content, draftId: draft.id }),
    ).rejects.toMatchObject({ status: 507 });
    expect(seen).toHaveLength(0);
    expect(service.getStatus()).toMatchObject({ busy: false, pendingSave: true });
    const pending = await client.getChatSession(session.id);
    expect(pending.messages).toHaveLength(1);
    expect(pending.messages[0]).toMatchObject({ content: draft.content, draftId: draft.id });
    expect(pending.turnStartedAt).toBeUndefined();
    expect(pending.lastTurnError).toContain('did not start a response');
    await expect(service.retrySave()).rejects.toThrow('Disk full');
    await expect(client.deleteChatSession(session.id)).rejects.toMatchObject({ status: 507 });
    await expect(client.createProject({ name: 'Blocked' })).rejects.toMatchObject({ status: 507 });
    await expect(service.setProvider('llama-cpp')).rejects.toMatchObject({ status: 507 });
    files.failWrite = undefined;
    await service.retrySave();
    expect(service.getStatus()).toMatchObject({ busy: false, pendingSave: false });
    expect(seen).toHaveLength(0);
    expect(files.entries.has('.transactions/pending.json')).toBe(false);
    expect((await client.getPromptDraft('default', draft.id)).status).toBe('sent');
    const reopened = await setup(undefined, files);
    const saved = await reopened.client.getChatSession(session.id);
    expect(saved.messages).toHaveLength(1);
    expect(saved.messages[0]?.id).toBe(pending.messages[0]?.id);
    expect(saved.turnStartedAt).toBeUndefined();
    expect(saved.lastTurnError).toContain('did not start a response');
    await reopened.client.sendToChatSession(session.id, { message: 'A new explicit message.' });
    await settled(reopened.service);
    expect(reopened.seen).toHaveLength(1);
    expect(reopened.seen[0]).not.toContain(draft.content);
  });
  it('rejects unauthorized callers, unsupported host operations and path traversal', async () => {
    const { service, client } = await setup();
    expect((await service.fetch('https://gezel.local/api/config')).status).toBe(401);
    const response = await service.fetch('https://gezel.local/api/terminal', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(501);
    await expect(client.writeDocument('../config.json', 'bad')).rejects.toThrow();
  });
  it('keeps draft sends atomic and rejects malformed edits without deleting user content', async () => {
    const { client, service } = await setup();
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    const draft = await client.createPromptDraft('default', {
      gezelId: gezels[0]!.id,
      sessionId: session.id,
      content: 'Please make a plan.',
    });
    const malformed = await service.fetch(
      `https://gezel.local/api/projects/default/prompt-drafts/${draft.id}/content`,
      {
        method: 'PUT',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(malformed.status).toBe(400);
    expect((await client.getPromptDraft('default', draft.id)).content).toBe('Please make a plan.');
    const invalidDelete = await service.fetch(
      `https://gezel.local/api/projects/default/prompt-drafts/${draft.id}/content`,
      { method: 'DELETE', headers: { authorization: 'Bearer test-token' } },
    );
    expect(invalidDelete.status).toBe(501);
    expect((await client.getPromptDraft('default', draft.id)).content).toBe('Please make a plan.');
    await client.sendToChatSession(session.id, { message: draft.content, draftId: draft.id });
    await settled(service);
    expect((await client.getPromptDraft('default', draft.id)).status).toBe('sent');
    expect((await client.getChatSession(session.id)).messages[0]?.draftId).toBe(draft.id);
    await client.writeProjectArtifactBinary(
      'default',
      'sample.json',
      new TextEncoder().encode('{"ok":true}'),
      'application/json',
      { createOnly: true },
    );
    expect((await client.readProjectArtifact('default', 'sample.json')).content).toBe(
      '{"ok":true}',
    );
  });
  it('waits for native cancellation before releasing the turn and permits unrelated navigation writes', async () => {
    let finish!: (value: { text: string; stopReason: 'cancelled' }) => void;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, service } = await setup({
      generate: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      cancel: async () => {
        await released;
        finish({ text: 'Partial answer', stopReason: 'cancelled' });
      },
    });
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    await client.sendToChatSession(session.id, { message: 'Start' });
    await client.updateConfig({ debugMode: false });
    const stopping = client.cancelChatSessionTurn(session.id);
    await expect(
      client.sendToChatSession(session.id, { message: 'Too soon' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(service.busy).toBe(true);
    release();
    await stopping;
    const saved = await client.getChatSession(session.id);
    expect(saved.messages.at(-1)).toMatchObject({
      content: 'Partial answer',
      status: 'interrupted',
      stopReason: 'cancelled',
    });
    expect(saved.turnStartedAt).toBeUndefined();
  });
  it('closing an event reader does not abort the turn; follow-ups retain referenced file context', async () => {
    const { client, service, seen } = await setup();
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    const stream = await service.fetch(client.projectEventsUrl('default'), {
      headers: { authorization: 'Bearer test-token' },
    });
    const reader = stream.body!.getReader();
    await reader.read();
    await reader.cancel();
    await client.writeDocument('brief.md', 'Remember the blue door.');
    await client.sendToChatSession(session.id, { message: 'Read [brief](documents/brief.md).' });
    await settled(service);
    await client.sendToChatSession(session.id, { message: 'What color was it?' });
    await settled(service);
    expect(seen[1]).toContain('Remember the blue door');
  });
  it('paginates messages with identical timestamps without dropping any', async () => {
    const { client, store } = await setup();
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    session.messages = [0, 1, 2, 3].map((n) => ({
      role: n % 2 ? 'assistant' : 'user',
      content: String(n),
      at: session.createdAt,
    }));
    await store.writeSession(session);
    const first = await client.listProjectTimeline('default', { limit: 2 });
    const second = await client.listProjectTimeline('default', {
      limit: 2,
      before: first.nextCursor,
    });
    expect([...second.messages, ...first.messages].map((m) => m.content)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
  });
});
