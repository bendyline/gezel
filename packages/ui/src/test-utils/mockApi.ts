import type { GezelClient } from '@bendyline/gezel-client';
import { vi } from 'vitest';

/**
 * Build a partial mock of the GezelClient that view tests can hand to
 * `vi.mock('../api.js')`. Each method defaults to a sensible empty
 * response so a test that doesn't care about a particular call doesn't
 * have to wire one up. Pass `overrides` to replace specific methods
 * with tailored fakes.
 *
 * Usage:
 *
 *   vi.mock('../api.js', () => ({ api: createMockApi() }));
 *   ...
 *   const { api } = await import('../api.js');
 *   vi.mocked(api.listGezels).mockResolvedValue({ gezels: [...] });
 *
 * Or for one-off tests:
 *
 *   vi.mock('../api.js', () => ({
 *     api: createMockApi({
 *       listHistory: vi.fn().mockResolvedValue({ entries: [] }),
 *     }),
 *   }));
 */
export type MockApi = Partial<Record<keyof GezelClient, ReturnType<typeof vi.fn>>>;

const DEFAULT_RESPONSES: Record<string, unknown> = {
  listGezels: { gezels: [] },
  listProjects: { projects: [] },
  listProjectWorkspaceHtmlPages: { files: [] },
  listWorkspaceWrites: { entries: [] },
  listAvailableCredentials: { credentials: [] },
  listConnectors: { bindings: [] },
  listConnectorActions: { pending: [] },
  listHistory: { entries: [] },
  listChannels: { channels: [] },
  listAudioVoices: { voices: [] },
  listInstalledVideoModels: { models: [] },
  listActiveVideoPulls: { pulls: [] },
  listCatalogItems: { items: [] },
  listFolders: { folders: [] },
  listDocuments: { documents: [] },
  search: { results: [], truncated: false },
  quickOpen: { results: [], truncated: false },
  listTasks: { tasks: [] },
  listProjectTasks: { tasks: [] },
  listQuestions: { questions: [] },
  listScripts: { scripts: [] },
  listProjectScripts: { scripts: [] },
  listStandardScripts: { scripts: [] },
  listUserScripts: { scripts: [] },
  toolScanFindings: {
    findings: [],
    counts: { total: 0, bySeverity: {}, byCategory: {}, bySource: {} },
    truncated: false,
    indexed: true,
  },
  getProjectScriptSource: { name: 'script', source: '', hash: 'h0', mtimeMs: 0 },
  saveProjectScriptSource: { status: 'saved', hash: 'h1', metaOk: true, diagnostics: [] },
  createProjectScript: { name: 'script', source: '', hash: 'h0' },
  draftProjectScript: { source: '' },
  getSdkTypes: { version: 'v0', files: [] },
  listMemories: { memories: [] },
  listGilde: { gilde: [] },
  listToolsets: { toolsets: [] },
  health: { ok: true, version: 'test' },
  getConfig: { provider: 'mock' },
  getMemoryProfile: {
    platform: 'darwin',
    totalRamBytes: 128_000_000_000,
    gpuVramBytes: null,
    source: 'darwin-unified',
    usableBytes: 112_000_000_000,
  },
  getQueueStatus: {
    providers: {},
    taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
    sessions: [],
    cache: [],
    at: '',
  },
  getCacheStats: { providers: [] },
  getMeesterStatus: {
    report: null,
    budget: { runsToday: 0, maxRunsPerDay: 4, lastRunAt: null },
    running: false,
  },
  getUsage: { providers: {} },
  getGezelGrowth: {
    state: {
      version: 1,
      level: 1,
      xp: 0,
      signals: { memoryXp: 0, lessonsXp: 0, taskXp: 0, consultXp: 0 },
      adoptedTraits: [],
      declinedProposals: [],
      unlockedCosmetics: [],
    },
    nextLevelXp: 100,
    activeTraits: [],
    driftedTraitIds: [],
  },
};

export function createMockApi(overrides: MockApi = {}): MockApi {
  const handler: ProxyHandler<MockApi> = {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof MockApi];
      // Lazily create a vi.fn() that resolves with the default response
      // for this method (or an empty object for unknown methods). The
      // first read installs it so subsequent reads return the same fn,
      // letting tests configure it after the fact via vi.mocked(api.x).
      const fn = vi.fn().mockResolvedValue(DEFAULT_RESPONSES[prop] ?? {});
      (target as Record<string, unknown>)[prop] = fn;
      return fn;
    },
  };
  return new Proxy({ ...overrides } as MockApi, handler);
}
