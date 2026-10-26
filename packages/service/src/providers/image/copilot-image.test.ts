import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { copilotImageSettings, decodeCopilotImage } from './copilot-image-settings.js';
import { CopilotImageProvider } from './copilot-image.js';
import type { CopilotImageClient, CopilotImageModel } from './copilot-runtime.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
  'base64',
);
const result = () => ({
  resultType: 'success',
  contents: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
  structuredContent: {
    imageGeneration: {
      images: [
        {
          imageId: `sha256:${createHash('sha256').update(png).digest('hex')}`,
          contentIndex: 0,
          mimeType: 'image/png',
        },
      ],
    },
  },
});
const model: CopilotImageModel = {
  id: 'gpt-image-test',
  name: 'Test image model',
  availability: 'available',
  isDefault: true,
  supportedOperations: ['generate', 'edit'],
};

function fixture() {
  const session = {
    rpc: {
      tools: {
        initializeAndValidate: vi.fn(async () => ({})),
        execute: vi.fn(
          async (_request: {
            name: string;
            arguments: Record<string, unknown>;
          }): Promise<unknown> => result(),
        ),
      },
    },
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true })),
    rpc: {
      models: {
        list: vi.fn(async (_request: { gitHubToken?: string }) => ({
          imageModels: [model] as CopilotImageModel[] | undefined,
        })),
      },
    },
    createSession: vi.fn(async (_config: Record<string, unknown>) => session),
  } satisfies CopilotImageClient;
  const provider = new CopilotImageProvider({
    home: '/unused',
    githubToken: 'test-token',
    clientFactory: async () => client,
  });
  return { provider, session, client };
}

describe('Copilot image settings', () => {
  it.each([
    ['draft', 'low'],
    ['standard', 'medium'],
    ['high', 'high'],
  ] as const)('passes %s quality natively', (quality, native) => {
    expect(
      copilotImageSettings({ prompt: 'A cat', aspectRatio: '2:3', quality }).arguments,
    ).toEqual({ prompt: 'A cat', size: '1024x1536', quality: native });
  });
  it('preserves auto defaults and lets explicit pixels override the aspect ratio', () => {
    expect(copilotImageSettings({ prompt: 'A cat' }).arguments).toEqual({ prompt: 'A cat' });
    expect(
      copilotImageSettings({ prompt: 'A cat', aspectRatio: '2:3', width: 1536, height: 1024 })
        .arguments.size,
    ).toBe('1536x1024');
  });
  it('reports size adjustments and unsupported controls, and carries negative instructions', () => {
    const settings = copilotImageSettings({
      prompt: 'A cat',
      aspectRatio: '16:9',
      negativePrompt: 'text',
      seed: 42,
      steps: 20,
      strength: 0.5,
    });
    expect(settings.arguments).toEqual({
      prompt: 'A cat\n\nAvoid the following in the image: text',
      size: '1536x1024',
    });
    expect(settings.notes.join(' ')).toMatch(/16:9.*1536x1024/);
    for (const setting of ['seed', 'step count', 'edit-strength', 'negative-prompt'])
      expect(settings.notes.join(' ')).toContain(setting);
  });
});

describe('CopilotImageProvider', () => {
  it('calls only the native image tool, verifies image bytes, and reports actual dimensions', async () => {
    const { provider, client, session } = fixture();
    const output = await provider.generate({
      prompt: 'A cat',
      width: 1024,
      height: 1024,
      quality: 'high',
    });
    expect(session.rpc.tools.execute).toHaveBeenCalledExactlyOnceWith({
      name: 'image_generation',
      arguments: { prompt: 'A cat', size: '1024x1024', quality: 'high' },
    });
    expect(client.rpc.models.list).toHaveBeenCalledWith({ gitHubToken: 'test-token' });
    expect(output.png).toEqual(png);
    expect(output.meta).toMatchObject({
      model: model.id,
      widthPx: 1,
      heightPx: 1,
      seed: 0,
      steps: 0,
    });
    expect(output.meta.settingsNotes?.join(' ')).toContain('returned 1x1');
    const config = client.createSession.mock.calls[0]![0];
    expect(config).toMatchObject({
      imageGeneration: { enabled: true, saveToDisk: false },
      availableTools: ['image_generation'],
      enableConfigDiscovery: false,
      mcpServers: {},
    });
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    await expect(access(config.workingDirectory as string)).rejects.toThrow();
  });
  it('passes reference images by private temporary paths and permits reads only of those files', async () => {
    const { provider, client, session } = fixture();
    let inputPath = '';
    session.rpc.tools.execute.mockImplementation(async (request) => {
      inputPath = (request.arguments.input_images as Array<{ path: string }>)[0]!.path;
      expect(await readFile(inputPath)).toEqual(png);
      const permission = client.createSession.mock.calls[0]![0].onPermissionRequest as (
        request: Record<string, unknown>,
      ) => { kind: string };
      expect(permission({ kind: 'custom-tool', toolName: 'image_generation' }).kind).toBe(
        'approve-once',
      );
      expect(permission({ kind: 'read', path: inputPath }).kind).toBe('approve-once');
      expect(
        permission({ kind: 'read', path: inputPath, managedApprovalRequired: true }).kind,
      ).toBe('reject');
      for (const denied of [
        { kind: 'shell' },
        { kind: 'write', path: inputPath },
        { kind: 'read', path: '/etc/passwd' },
        { kind: 'custom-tool', toolName: 'generate_image' },
      ])
        expect(permission(denied).kind).toBe('reject');
      return result();
    });
    await provider.generate({
      prompt: 'Make the cat orange',
      inputImages: [{ data: png, mimeType: 'image/png' }],
    });
    await expect(access(inputPath)).rejects.toThrow();
  });
  it('does not silently substitute an unsupported model or omit edit inputs', async () => {
    const { provider, client, session } = fixture();
    await expect(provider.generate({ prompt: 'A cat', model: 'other-model' })).rejects.toThrow(
      'cannot select',
    );
    client.rpc.models.list.mockResolvedValue({
      imageModels: [{ ...model, supportedOperations: ['generate'] }],
    });
    await expect(
      provider.generate({ prompt: 'Edit', inputImages: [{ data: png, mimeType: 'image/png' }] }),
    ).rejects.toThrow('cannot edit');
    expect(session.rpc.tools.execute).not.toHaveBeenCalled();
  });
  it('distinguishes sign-in, outdated runtime, and account access failures without generating', async () => {
    const { provider, client, session } = fixture();
    client.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    expect(await provider.health()).toMatchObject({
      status: 'not-configured',
      error: expect.stringContaining('Sign in'),
    });
    client.getAuthStatus.mockResolvedValue({ isAuthenticated: true });
    client.rpc.models.list.mockResolvedValue({ imageModels: undefined });
    expect(await provider.health()).toMatchObject({
      status: 'not-configured',
      error: expect.stringContaining('Update'),
    });
    client.rpc.models.list.mockResolvedValue({
      imageModels: [{ ...model, availability: 'unavailable' }],
    });
    const [health, models] = await Promise.all([provider.health(), provider.listInstalledModels()]);
    expect(health).toMatchObject({
      status: 'not-configured',
      error: expect.stringContaining('not available'),
    });
    expect(models).toEqual([]);
    expect(session.rpc.tools.execute).not.toHaveBeenCalled();
  });
  it('cancels an active generation without retrying or returning a late image', async () => {
    const { provider, session } = fixture();
    let complete!: (value: unknown) => void;
    session.rpc.tools.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const ctrl = new AbortController();
    const pending = provider.generate({ prompt: 'A cat', signal: ctrl.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'image_generation_cancelled' });
    await vi.waitFor(() => expect(session.rpc.tools.execute).toHaveBeenCalledOnce());
    ctrl.abort();
    await rejected;
    expect(session.abort).toHaveBeenCalledOnce();
    complete(result());
    await vi.waitFor(() => expect(session.disconnect).toHaveBeenCalledOnce());
    expect(session.rpc.tools.execute).toHaveBeenCalledOnce();
  });
  it('fails before starting when already cancelled and aborts active work on shutdown', async () => {
    const { provider, client, session } = fixture();
    await expect(
      provider.generate({ prompt: 'A cat', signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'image_generation_cancelled' });
    expect(client.start).not.toHaveBeenCalled();
    session.rpc.tools.execute.mockImplementation(async () => new Promise(() => {}));
    const pending = provider.generate({ prompt: 'A cat' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'image_generation_cancelled' });
    await vi.waitFor(() => expect(session.rpc.tools.execute).toHaveBeenCalledOnce());
    await provider.shutdown();
    await rejected;
    await vi.waitFor(() => expect(session.disconnect).toHaveBeenCalledOnce());
    const directory = client.createSession.mock.calls[0]![0].workingDirectory as string;
    await vi.waitFor(async () => {
      await expect(access(directory)).rejects.toThrow();
    });
  });
  it('never accepts prose, mismatched bytes, or failed tool results as an image', () => {
    expect(() =>
      decodeCopilotImage({ resultType: 'success', textResultForLlm: 'Saved image.png' }),
    ).toThrow('exactly one');
    const bad = result();
    bad.structuredContent.imageGeneration.images[0]!.imageId = 'sha256:wrong';
    expect(() => decodeCopilotImage(bad)).toThrow('invalid image data');
    expect(() => decodeCopilotImage({ resultType: 'failure', error: 'Quota exhausted' })).toThrow(
      'Quota exhausted',
    );
  });
});
