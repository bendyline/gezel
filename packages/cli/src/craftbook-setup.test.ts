import { describe, expect, it, vi } from 'vitest';
import {
  type CraftbookSetupClient,
  type SetupPrompter,
  ensureCraftbookSetup,
} from './craftbook-setup.js';

const KEY = 'BSA-secret-key-123';

interface FakeState {
  securityPolicy?: Record<string, unknown>;
  webSearch?: { provider?: string };
  hasBraveSearchApiKey: boolean;
  installed: string[];
  searchFails?: string;
}

function fakeClient(state: FakeState) {
  const client = {
    getConfig: vi.fn(async () => ({
      provider: 'llama-cpp',
      ...(state.securityPolicy ? { securityPolicy: state.securityPolicy } : {}),
      ...(state.webSearch ? { webSearch: state.webSearch } : {}),
      hasBraveSearchApiKey: state.hasBraveSearchApiKey,
    })),
    updateConfig: vi.fn(async (patch: Record<string, unknown>) => {
      if (patch.securityPolicy)
        state.securityPolicy = patch.securityPolicy as Record<string, unknown>;
      if (patch.webSearch) state.webSearch = patch.webSearch as { provider?: string };
      if (typeof patch.braveSearchApiKey === 'string')
        state.hasBraveSearchApiKey = patch.braveSearchApiKey !== '';
      return {};
    }),
    getCatalogItem: vi.fn(async (_kind: string, id: string) => {
      if (id === 'no-such-model') throw new Error('not found');
      return {
        manifest: { kind: 'chat-model', id, llamaCpp: { approxSizeBytes: 16_000_000_000 } },
      };
    }),
    checkModelDownloadSpace: vi.fn(async ({ sizeBytes }: { sizeBytes: number }) => ({
      known: true,
      ok: true,
      freeBytes: 500_000_000_000,
      requiredBytes: sizeBytes,
      storageLocation: 'Gezel model storage',
    })),
    getNativeEngineStatus: vi.fn(async () => ({ pinned: false, platformKey: null, engines: [] })),
    ensureNativeEngine: vi.fn(),
    listLlamaCppModels: vi.fn(async () => ({ models: state.installed.map((id) => ({ id })) })),
    listMlxModels: vi.fn(async () => ({ models: [] })),
    listDs4Models: vi.fn(async () => ({ models: [] })),
    installLlamaCppModel: vi.fn(async (id: string, onEvent: (event: unknown) => void) => {
      state.installed.push(id);
      onEvent({ type: 'done' });
    }),
    installMlxModel: vi.fn(),
    installDs4Model: vi.fn(),
    toolWebSearch: vi.fn(async () => {
      if (state.searchFails) {
        throw Object.assign(new Error('API error 502'), {
          details: { error: `${state.searchFails} token=${KEY}` },
        });
      }
      return { results: [], source: 'brave', query: 'q', durationMs: 1 };
    }),
  };
  return client;
}

const asClient = (client: ReturnType<typeof fakeClient>) =>
  client as unknown as CraftbookSetupClient;

function prompter(answers: { confirm?: boolean[]; secret?: string[] }): SetupPrompter & {
  questions: string[];
} {
  const confirms = [...(answers.confirm ?? [])];
  const secrets = [...(answers.secret ?? [])];
  const questions: string[] = [];
  return {
    questions,
    confirm: async (question) => {
      questions.push(question);
      return confirms.shift() ?? false;
    },
    secret: async (question) => {
      questions.push(question);
      return secrets.shift() ?? '';
    },
  };
}

const LOCKDOWN = {
  level: 'lockdown',
  allowFileEdits: true,
  allowExternalChat: true,
  allowExternalServices: false,
  allowScriptExecution: true,
  allowAppNetwork: true,
};

const stories = {
  services: [{ kind: 'web-search' as const, reason: 'research checks every fact' }],
  models: [
    { id: '{{writerModel}}', provider: 'llama-cpp', reason: 'writes the stories' },
    { id: 'gemma4-31b-q4', provider: 'llama-cpp', reason: 'checks every sentence' },
  ],
};
const paramSchema = {
  type: 'object',
  properties: { writerModel: { type: 'string', default: 'qwen3.8-27b-q4' } },
};

const base = { projectId: 'p1', label: 'Stories', needs: stories, paramSchema };

describe('ensureCraftbookSetup', () => {
  it('does nothing for a book that declares no needs', async () => {
    const client = fakeClient({ hasBraveSearchApiKey: false, installed: [] });
    await ensureCraftbookSetup(asClient(client), {
      ...base,
      needs: {},
      prompter: null,
      write: () => {},
    });
    expect(client.getConfig).not.toHaveBeenCalled();
  });

  it('starts without a question when everything is in place', async () => {
    const client = fakeClient({
      securityPolicy: { ...LOCKDOWN, level: 'free', allowExternalServices: true },
      webSearch: { provider: 'brave' },
      hasBraveSearchApiKey: true,
      installed: ['qwen3.8-27b-q4', 'gemma4-31b-q4'],
    });
    const ask = prompter({});
    await ensureCraftbookSetup(asClient(client), { ...base, prompter: ask, write: () => {} });
    expect(ask.questions).toEqual([]);
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it('away from a terminal, changes nothing and names every fix', async () => {
    const client = fakeClient({
      securityPolicy: LOCKDOWN,
      hasBraveSearchApiKey: false,
      installed: [],
    });
    const error = await ensureCraftbookSetup(asClient(client), {
      ...base,
      prompter: null,
      write: () => {},
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Stories is not set up to run yet');
    expect(message).toContain('gezel security external-services on');
    expect(message).toContain('gezel secret set braveSearchApiKey');
    expect(message).toContain('gezel model pull qwen3.8-27b-q4 --provider llama-cpp');
    expect(message).toContain('gezel model pull gemma4-31b-q4 --provider llama-cpp');
    expect(message).toContain('16.00 GB');
    expect(client.updateConfig).not.toHaveBeenCalled();
    expect(client.installLlamaCppModel).not.toHaveBeenCalled();
  });

  it('at a terminal, turns everything on with explicit yeses and downloads the models', async () => {
    const state: FakeState = {
      securityPolicy: LOCKDOWN,
      hasBraveSearchApiKey: false,
      installed: [],
    };
    const client = fakeClient(state);
    const ask = prompter({ confirm: [true, true], secret: [`  ${KEY}  `] });
    const written: string[] = [];
    await ensureCraftbookSetup(asClient(client), {
      ...base,
      prompter: ask,
      write: (text) => written.push(text),
    });

    // Lockdown plus External services is the Unrestricted preset, and the
    // person is told so before agreeing.
    expect(ask.questions[0]).toContain('from Lockdown to Unrestricted');
    expect(state.securityPolicy).toMatchObject({ level: 'free', allowExternalServices: true });
    expect(client.updateConfig).toHaveBeenCalledWith({
      braveSearchApiKey: KEY,
      webSearch: { provider: 'brave' },
    });
    expect(client.toolWebSearch).toHaveBeenCalledTimes(1);
    expect(ask.questions[2]).toContain('32.00 GB');
    expect(state.installed).toEqual(['qwen3.8-27b-q4', 'gemma4-31b-q4']);
    expect(written.join('')).not.toContain(KEY);
  });

  it('stops at the first no, and names what is left', async () => {
    const client = fakeClient({
      securityPolicy: LOCKDOWN,
      hasBraveSearchApiKey: false,
      installed: [],
    });
    const error = await ensureCraftbookSetup(asClient(client), {
      ...base,
      prompter: prompter({ confirm: [false] }),
      write: () => {},
    }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Not set up, so Stories did not start/);
    expect((error as Error).message).toContain('gezel model pull gemma4-31b-q4');
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it('fails until a search key is given', async () => {
    const client = fakeClient({
      securityPolicy: { ...LOCKDOWN, allowExternalServices: true },
      hasBraveSearchApiKey: false,
      installed: ['qwen3.8-27b-q4', 'gemma4-31b-q4'],
    });
    const error = await ensureCraftbookSetup(asClient(client), {
      ...base,
      prompter: prompter({ secret: [''] }),
      write: () => {},
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain('gezel secret set braveSearchApiKey');
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it('takes back a key Brave refuses, without printing it', async () => {
    const state: FakeState = {
      securityPolicy: { ...LOCKDOWN, allowExternalServices: true },
      hasBraveSearchApiKey: false,
      installed: ['qwen3.8-27b-q4', 'gemma4-31b-q4'],
      searchFails: 'Brave search failed: HTTP 401 Unauthorized',
    };
    const client = fakeClient(state);
    const error = await ensureCraftbookSetup(asClient(client), {
      ...base,
      prompter: prompter({ secret: [KEY] }),
      write: () => {},
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain(KEY);
    expect(state.hasBraveSearchApiKey).toBe(false);
  });

  it('checks the model a run actually picks', async () => {
    const client = fakeClient({ hasBraveSearchApiKey: false, installed: ['gemma4-31b-q4'] });
    await ensureCraftbookSetup(asClient(client), {
      ...base,
      needs: { models: stories.models },
      params: { writerModel: 'gemma4-31b-q4' },
      prompter: null,
      write: () => {},
    });
  });

  it('refuses a model the catalog does not have before asking anything', async () => {
    const client = fakeClient({ hasBraveSearchApiKey: false, installed: [] });
    const ask = prompter({ confirm: [true] });
    const error = await ensureCraftbookSetup(asClient(client), {
      ...base,
      needs: { models: [{ id: 'no-such-model' }] },
      prompter: ask,
      write: () => {},
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain('no-such-model');
    expect(ask.questions).toEqual([]);
  });
});
