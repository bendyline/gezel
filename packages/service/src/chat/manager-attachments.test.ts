import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * End-to-end coverage for the chat attachment flow: when a user's
 * markdown message contains an `attachments/<filename>` image ref,
 * the service loads the bytes off disk and passes them to the
 * provider as an `ImageAttachment`. The full UI-side flow (paste →
 * upload → insert into markdown) is pieces higher up the stack — the
 * critical server contract tested here is:
 *
 *   1. Write image bytes via `store.writeProjectAttachment(...)`.
 *   2. Send a chat message whose markdown references `attachments/<name>`.
 *   3. The provider's `sendAndWait` receives `{ attachments: [...] }`
 *      with the right base64 payload + mime type.
 *
 * If this test regresses, pasted images silently drop off the wire
 * and the gezel sees no image — exactly the bug the user reported.
 */

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-attach-e2e-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Mira', role: 'Designer' });
  await store.createProject({ name: 'Default' });
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — project-scoped image attachments reach the provider', () => {
  it('extracts and forwards an image when the user message references attachments/<file>', async () => {
    // Arrange: the user "pastes" a PNG — we write it to the project's
    // attachments folder exactly the way the HTTP attachment route
    // would. The returned `relativePath` is what the UI embeds in the
    // chat markdown.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
    ]);
    const { relativePath } = await store.writeProjectAttachment('default', pngBytes, 'image/png');
    expect(relativePath).toMatch(/^attachments\/[\w-]+\.png$/);

    // Create a session + script a trivial provider reply so the send
    // doesn't block.
    const session = await manager.createSession({ gezelId: 'mira' });
    mock.script('got it');

    // Act: send a message exactly as the composer would serialize it.
    const userMarkdown = `here you go ![screenshot](${relativePath})`;
    await manager.send(session.id, userMarkdown);

    // Assert: the MockProvider's sendAndWait received one attachment
    // whose base64 bytes match what we wrote, with the right mime.
    const sendCall = mock.calls.find((c) => c.kind === 'send');
    expect(sendCall, 'expected a send call recorded on the provider').toBeDefined();
    const attachments = sendCall?.sendOpts?.attachments ?? [];
    expect(attachments, 'image attachment must reach the provider').toHaveLength(1);
    expect(attachments[0]!.mimeType).toBe('image/png');
    expect(Buffer.from(attachments[0]!.base64, 'base64').equals(pngBytes)).toBe(true);
    expect(attachments[0]!.filename).toMatch(/\.png$/);
  });

  it('silently drops refs to missing attachments but still sends the text', async () => {
    const session = await manager.createSession({ gezelId: 'mira' });
    mock.script('acknowledged');

    const userMarkdown = 'here ![](attachments/does-not-exist.png) you go';
    await manager.send(session.id, userMarkdown);

    const sendCall = mock.calls.find((c) => c.kind === 'send');
    expect(sendCall).toBeDefined();
    expect(sendCall?.sendOpts?.attachments ?? []).toHaveLength(0);
    // The text still flows; the message didn't fail just because the
    // ref didn't resolve.
    expect(sendCall?.prompt).toContain('here');
    expect(sendCall?.prompt).toContain('you go');
  });

  it('forwards a legacy images/<filename> ref when the file lives in the session folder', async () => {
    // Backwards compat: chats that pre-date the project-scoped
    // attachment rework still render their embedded images.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const session = await manager.createSession({ gezelId: 'mira' });
    const { relativePath } = await store.writeSessionImage(
      'default',
      session.id,
      pngBytes,
      'image/png',
    );
    expect(relativePath).toMatch(/^images\/[\w-]+\.png$/);
    mock.script('legacy ok');

    await manager.send(session.id, `old style ![](${relativePath})`);

    const sendCall = mock.calls.find((c) => c.kind === 'send');
    const attachments = sendCall?.sendOpts?.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.mimeType).toBe('image/png');
    expect(Buffer.from(attachments[0]!.base64, 'base64').equals(pngBytes)).toBe(true);
  });

  it('forwards multiple attachments in the order they appear in markdown', async () => {
    const png1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    const png2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]);
    const a = await store.writeProjectAttachment('default', png1, 'image/png');
    const b = await store.writeProjectAttachment('default', png2, 'image/png');
    const session = await manager.createSession({ gezelId: 'mira' });
    mock.script('got both');

    await manager.send(session.id, `first ![](${a.relativePath}) then ![](${b.relativePath})`);

    const sendCall = mock.calls.find((c) => c.kind === 'send');
    const attachments = sendCall?.sendOpts?.attachments ?? [];
    expect(attachments).toHaveLength(2);
    expect(Buffer.from(attachments[0]!.base64, 'base64').equals(png1)).toBe(true);
    expect(Buffer.from(attachments[1]!.base64, 'base64').equals(png2)).toBe(true);
  });
});
