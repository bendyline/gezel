import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { PortableStore } from '../src/runtime/store.js';
import { portableFixture } from '../src/runtime/test-files.js';

async function setup(generate?: PortableInference['generate']) {
  const fixture = portableFixture();
  const requests: Parameters<PortableInference['generate']>[0][] = [];
  const service = new PortableProductService(
    fixture.store,
    {
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Fixture',
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
      generate: async (request, delta) => {
        requests.push(request);
        return generate ? generate(request, delta) : { text: 'Saved response', stopReason: 'stop' };
      },
      cancel: async () => {},
    },
    'secret',
  );
  await service.initialize();
  const client = new GezelClient({
    baseUrl: 'https://gezel.local',
    token: 'secret',
    fetch: service.fetch,
  });
  const sender = (await fixture.store.readConfig()).meesterGezelId!;
  const recipient = await fixture.store.createGezel({ name: 'Alex', role: 'Developer' });
  const project = await fixture.store.createProject({ name: 'Source review' });
  const body = {
    fromGezelId: sender,
    projectId: project.id,
    text: 'Correct the reported result.',
    suppressReply: true,
  };
  return { ...fixture, service, client, requests, sender, recipient, project, body };
}
async function settle(service: PortableProductService) {
  await vi.waitFor(() => expect(service.busy).toBe(false));
}

describe('ordinary client crew messages on the portable host', () => {
  it('retains the project conversation and exact repair metadata across reopen', async () => {
    const f = await setup();
    const first = await f.client.messageGezel(f.recipient.name, f.body);
    await settle(f.service);
    const hint = {
      kind: 'repair-file' as const,
      path: 'output/report.json',
      mutationPath: 'src/report.ts',
      readPaths: ['src/report.ts'],
      strategy: 'patch' as const,
    };
    const expected = { kind: 'file' as const, filePath: 'output/report.json' };
    const second = await f.client.messageGezel(f.recipient.id, {
      ...f.body,
      fileTurnIntent: hint,
      expectedDeliverable: expected,
    });
    await settle(f.service);
    expect(second).toMatchObject({
      accepted: true,
      sessionId: first.sessionId,
      toGezelId: f.recipient.id,
      deliveryState: 'dispatched',
    });
    const reopened = new PortableStore(f.options);
    const session = await reopened.getSession(f.recipient.id, second.sessionId);
    expect(session?.projectId).toBe(f.project.id);
    expect(session?.expectedDeliverable).toEqual(expected);
    expect(session?.messages.filter((m) => m.role === 'user').at(-1)).toMatchObject({
      fileTurnIntent: hint,
      from: { gezelId: f.sender, kind: 'delegation' },
    });
    const prompt = f.requests.at(-1)!.messages.at(-1)!.content;
    expect(prompt).toContain(f.body.text);
    expect(JSON.parse(prompt.split('\n').at(-1)!)).toEqual({
      fileTurnIntent: hint,
      expectedDeliverable: expected,
    });
    expect(prompt).toContain('grants no additional filesystem or tool access');
    expect(f.requests).toHaveLength(2); // suppressReply never reawakens the sender.
    await f.client.sendToChatSession(second.sessionId, { message: 'Explain the saved result.' });
    await settle(f.service);
    expect(f.requests.at(-1)!.messages.at(-1)!.content).not.toContain('mutationPath');
  });

  it('keeps source-session attribution and unambiguous project routing', async () => {
    const f = await setup();
    const origin = await f.store.createSession({ gezelId: f.sender, projectId: f.project.id });
    const result = await f.client.messageGezel(f.recipient.id, {
      fromGezelId: f.sender,
      fromSessionId: origin.id,
      text: 'Review it.',
      suppressReply: true,
    });
    await settle(f.service);
    const session = await f.client.getChatSession(result.sessionId);
    expect(session.projectId).toBe(f.project.id);
    expect(session.messages[0]?.from?.sessionId).toBe(origin.id);
    const later = await f.client.messageGezel(f.recipient.id, {
      fromGezelId: f.sender,
      text: 'Follow up.',
      suppressReply: true,
    });
    await settle(f.service);
    expect(later.sessionId).toBe(result.sessionId);
  });

  it.each([
    { fileTurnIntent: { kind: 'repair-file', path: '../outside.ts' } },
    { fileTurnIntent: { kind: 'repair-file', path: 'result.json', mutationPath: '/outside.ts' } },
    { expectedDeliverable: { kind: 'file', filePath: '../outside.md' } },
    { expectedDeliverable: { kind: 'file', filePath: 'report.pdf' } },
    { expectedDeliverable: { kind: 'file', filePath: 'photo.png' } },
    {
      expectedDeliverable: {
        kind: 'file',
        filePath: 'report.md',
        checks: [{ kind: 'minBytes', file: 'report.md', bytes: 4 }],
      },
    },
    { suppressReply: false },
  ])('rejects unsupported or unsafe metadata before dispatch: %j', async (patch) => {
    const f = await setup();
    await expect(
      f.client.messageGezel(f.recipient.id, { ...f.body, ...patch } as Parameters<
        GezelClient['messageGezel']
      >[1]),
    ).rejects.toThrow();
    expect(await f.store.listSessions({ gezelId: f.recipient.id })).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('rejects a forged source session and self-delivery', async () => {
    const f = await setup();
    const other = await f.store.createSession({ gezelId: f.recipient.id });
    await expect(
      f.client.messageGezel(f.recipient.id, { ...f.body, fromSessionId: other.id }),
    ).rejects.toMatchObject({
      status: 400,
      details: { error: expect.stringContaining('does not belong') },
    });
    await expect(f.client.messageGezel(f.sender, f.body)).rejects.toMatchObject({
      status: 400,
      details: { error: expect.stringContaining('itself') },
    });
    expect(f.requests).toEqual([]);
  });

  it('does not elevate a coordinator into a workspace writer', async () => {
    const f = await setup();
    const coordinator = await f.store.createGezel({ name: 'Foreman', role: 'Voorman' });
    await expect(
      f.client.messageGezel(coordinator.id, {
        ...f.body,
        expectedDeliverable: { kind: 'file', filePath: 'report.md' },
      }),
    ).rejects.toMatchObject({
      status: 400,
      details: { error: expect.stringContaining('cannot write') },
    });
    expect(await f.store.listSessions({ gezelId: coordinator.id })).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('rejects simultaneous deliveries and background admission without losing the original turn', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = await setup(async () => {
      await pending;
      return { text: 'Complete', stopReason: 'stop' };
    });
    const first = await f.client.messageGezel(f.recipient.id, f.body);
    await expect(f.client.messageGezel(f.recipient.id, f.body)).rejects.toMatchObject({
      status: 409,
      details: { error: expect.stringContaining('current response') },
    });
    finish();
    await settle(f.service);
    const session = await f.client.getChatSession(first.sessionId);
    expect(session.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    await f.service.suspend();
    await expect(f.client.messageGezel(f.recipient.id, f.body)).rejects.toMatchObject({
      status: 409,
      details: { error: expect.stringContaining('Return to Gezel') },
    });
    expect(f.requests).toHaveLength(1);
  });
});
