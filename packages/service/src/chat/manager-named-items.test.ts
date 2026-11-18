import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PromptInclusion } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import type { PromptConnectorService } from '../prompt-connectors/service.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A web address the person names, with a saved copy in the project, opens
 * their turn: the model reads the copy's summary and text, and the stored
 * message records what it was given. See docs/prompt-connectors.md.
 */

const PAGE: PromptInclusion = {
  connectorType: 'website',
  subject: 'https://gezel.com/platform',
  label: 'gezel.com/platform',
  title: 'The Gezel platform',
  path: 'data/saved-pages/gezel-com/001--platform--1a2b3c4d.md',
  summary: 'Gezel runs on your own computer.',
};
const BLOCK =
  '[Named in this message: saved copies.]\n\nPage: The Gezel platform\nGezel runs on your own computer.';
const ASK = 'Can you summarize https://gezel.com/platform?';

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;
let asked: Array<{ text: string; toolNames?: ReadonlySet<string> }>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-named-items-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  const memory = {
    save: async () => ({ status: 'saved' as const }),
    search: async () => [],
    searchAll: async () => [],
    reindex: async () => 0,
    writeSummary: async () => {},
    getRecent: async () => '',
  } as unknown as MemoryManager;
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  asked = [];
  manager.setPromptConnectors({
    turnContext: async (
      _project: unknown,
      text: string,
      opts: { toolNames?: ReadonlySet<string> },
    ) => {
      asked.push({ text, ...(opts.toolNames ? { toolNames: opts.toolNames } : {}) });
      return text.includes('gezel.com') ? { prompt: BLOCK, inclusions: [PAGE] } : null;
    },
  } as unknown as PromptConnectorService);
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function sendTurn(sessionId: string, text: string, opts?: { nudge?: boolean }) {
  mock.script('ok', 'NONE');
  const before = mock.calls.length;
  await manager.send(sessionId, text, opts);
  return mock.calls.slice(before).find((call) => call.kind === 'send')?.prompt ?? '';
}

describe('a saved page the person names', () => {
  it('opens the turn and is recorded on the stored message', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const prompt = await sendTurn(session.id, ASK);
    expect(prompt).toContain(BLOCK);
    // The person's words stay last.
    expect(prompt.indexOf(BLOCK)).toBeLessThan(prompt.indexOf(ASK));
    expect(prompt.endsWith(ASK)).toBe(true);

    const stored = (await store.getSession('ada', session.id))?.messages.find(
      (m) => m.role === 'user',
    );
    expect(stored?.content).toBe(ASK);
    expect(stored?.inclusions).toEqual([PAGE]);
    // Kept with the turn, so a rebuilt session replays exactly what was sent.
    expect(stored?.sentPreamble).toContain(BLOCK);
  });

  it('adds nothing to a message that names nothing saved', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    const prompt = await sendTurn(session.id, 'What should we build next?');
    expect(prompt).not.toContain('Named in this message');
    const stored = (await store.getSession('ada', session.id))?.messages.find(
      (m) => m.role === 'user',
    );
    expect(stored?.inclusions).toBeUndefined();
  });

  it('is never read for a visitor of a shared page', async () => {
    const visitor = await manager.createSession({ gezelId: 'ada', visitorAccess: true });
    const prompt = await sendTurn(visitor.id, ASK);
    expect(prompt).not.toContain('The Gezel platform');
    expect(asked).toEqual([]);
  });
});
