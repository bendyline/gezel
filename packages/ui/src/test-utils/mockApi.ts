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
  getEngineRetention: { idleTimeoutMs: 300_000 },
  listGezels: { gezels: [] },
  listProjectLocalGezels: { gezels: [] },
  listProjects: { projects: [] },
  listProjectWorkspaceHtmlPages: { files: [] },
  getProjectIndexStatus: { state: 'never' },
  toolListFileIssues: {
    issues: [],
    counts: { total: 0, bySeverity: {}, byCategory: {} },
    truncated: false,
    indexed: false,
    reviewedFiles: 0,
    eligibleFiles: 0,
  },
  toolFileReview: { path: '', found: false },
  listWorkspaceWrites: { entries: [] },
  listAvailableCredentials: { credentials: [] },
  listConnectors: { bindings: [] },
  listConnectorActions: { pending: [] },
  listHistory: { entries: [] },
  listChannels: { channels: [] },
  listAudioVoices: { voices: [] },
  getRecognitionHealth: { state: 'no-model' },
  listRecognitionCatalog: { models: [] },
  listInstalledRecognitionModels: { models: [] },
  listInstalledVideoModels: { models: [] },
  listIncompleteLlamaCppModels: { incomplete: [] },
  listIncompleteDs4Models: { incomplete: [] },
  listIncompleteMlxModels: { incomplete: [] },
  listSharedModelMigrationCandidates: { available: false, candidates: [] },
  listModelFitness: { records: [], probing: [] },
  listActiveVideoPulls: { pulls: [] },
  listCatalogItems: { items: [] },
  listFolders: { folders: [] },
  listDocuments: { documents: [] },
  search: { results: [], truncated: false },
  quickOpen: { results: [], truncated: false },
  listTasks: { tasks: [] },
  listProjectTasks: { tasks: [] },
  // Chat-thread surfaces (the pill row, SessionSwitcher) fetch these on
  // mount. Without defaults, any view test that merely renders a project
  // chat blows up on `undefined.then` rather than showing an empty row.
  listChatSessions: { sessions: [] },
  listTaskSessions: { sessions: [] },
  listInflightTurns: { inflight: [] },
  listSuggestedWork: { items: [] },
  getReportActions: { actions: [], issues: [], stale: [] },
  getNightShiftReview: {
    windowKey: '2026-07-29',
    windowStart: '2026-07-29T22:00:00.000Z',
    windowEnd: '2026-07-30T06:00:00.000Z',
    tasksCompleted: [],
    reports: [],
  },
  listProjectCodeReviews: { reviews: [] },
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
  listMemoryDays: { days: [] },
  readMemoryDay: { content: '' },
  readMemorySummary: { content: '' },
  readMemoryLessons: { content: '' },
  getSdkTypes: { version: 'v0', files: [] },
  listMemories: { memories: [] },
  getHandboekArticle: {
    id: 'welcome',
    title: 'What is gezel?',
    area: 'conceptual',
    markdown: '# What is gezel?\n\nA crew of AI companions that works for you.',
    figures: [],
    generated: false,
  },
  listGilde: { gilde: [] },
  listToolsets: { toolsets: [] },
  health: { ok: true, version: 'test' },
  // A realistic, PII-free profile so any view test that mounts a surface
  // hosting a "Report error on GitHub…" link renders a plausible machine
  // block rather than the fetch-failed fallback.
  getSystemDiagnostics: {
    version: '1.0.0-test',
    sampledAt: '2026-07-31T18:32:00.000Z',
    runtime: {
      nodeVersion: '22.14.0',
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.8.0-51-generic',
      platformKey: 'linux-x64',
    },
    hardware: {
      totalRamBytes: 64_000_000_000,
      gpuVramBytes: 24_000_000_000,
      usableBytes: 22_800_000_000,
      source: 'gpu-vulkan',
      gpuVendor: 'amd',
      description: 'AMD GPU: 24.0 GB VRAM',
      tier: 'medium',
      gpuDevices: [{ name: 'AMD Radeon RX 7900 XTX', totalMiB: 24_560 }],
    },
    engine: {
      nativeRelease: 'native-v0.0.0',
      nativePinned: true,
      installedEngines: ['llama-server'],
      llamaCppBackend: 'vulkan',
    },
    models: {
      defaultProvider: 'llama-cpp',
      defaultModel: 'gemma4-26b-q4',
      installed: [{ id: 'gemma4-26b-q4', provider: 'llama-cpp', parameterSize: '26B' }],
    },
  },
  getConfig: { provider: 'mock' },
  getCodexSetupStatus: {
    state: 'not-configured',
    models: [],
    reasons: [],
    codexInstalled: false,
    endpointsEnabled: true,
    profileName: 'gezel',
    profilePath: '/tmp/gezel-codex/config.toml',
    launchCommand: 'codex --profile gezel',
    bridge: { baseUrl: 'https://127.0.0.1:6228/v1', listening: true, port: 6228 },
    canConfigure: false,
    canRemove: false,
  },
  getLlamaCppContextSizing: { policy: 'adaptive' },
  getModelContextOverrides: { overrides: {} },
  // Copilot is an on-demand install, so most gates read this rather than a
  // stored token. Default to installed so tests that predate the gating keep
  // seeing the provider offered.
  getCopilotStatus: {
    available: true,
    source: 'managed',
    managed: 'current',
    installedVersion: '1.0.7',
    pinnedVersion: '1.0.7',
    updateAvailable: false,
  },
  getChatSessionInflight: { inflight: null },
  getMemoryProfile: {
    platform: 'darwin',
    totalRamBytes: 128_000_000_000,
    gpuVramBytes: null,
    source: 'darwin-unified',
    usableBytes: 112_000_000_000,
  },
  getMachineMemoryUsage: {
    kind: 'unified',
    totalBytes: 128_000_000_000,
    usedBytes: 48_000_000_000,
    gezelBytesEstimated: 12_000_000_000,
    gezelBytesObserved: 12_000_000_000,
    gezelInfraBytes: 2_000_000_000,
    gezelModelWeightsBytes: 8_000_000_000,
    gezelModelCacheBytes: 2_000_000_000,
    engineReservedBytes: 10_000_000_000,
    engineBudgetBytes: 76_800_000_000,
    enginePools: {
      kind: 'unified',
      vramBytes: 0,
      ramShareBytes: 76_800_000_000,
      fastBytes: 76_800_000_000,
    },
    residentModels: [],
    gezelEngineProcessCount: 1,
    orphanedGezelEngineProcessCount: 0,
    otherBytes: 36_000_000_000,
    cachedBytes: 0,
    freeBytes: 80_000_000_000,
    sampledAt: '2026-07-29T12:00:00.000Z',
    source: 'system-memory',
    deviceNames: [],
  },
  checkModelDownloadSpace: {
    known: true,
    ok: true,
    freeBytes: 80_000_000_000,
    requiredBytes: 4_000_000_000,
    storageLocation: 'Gezel model storage',
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
