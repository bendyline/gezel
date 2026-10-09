import { craftbookParamDefaults, interpolateContext } from './craftbook-params.js';
import type { Craftbook, CraftbookModelNeed, CraftbookServiceNeed } from './schemas/craftbook.js';

/**
 * What a craftbook needs from this Gezel before it can run, and what is
 * still missing. Pure: a host gathers the state (config, installed models)
 * and decides how to close each gap — `gezel do` asks in the terminal.
 *
 * WHY: a batch book that needs web search and two 20 GB models used to
 * discover each missing piece one run at a time, or hours in. The needs are
 * declared on the book (`models`, `services`) or, for a workflow module that
 * computes them, handed over at run time; both resolve through here.
 */

/** The needs a book declares, or a workflow module computes at run time. */
export type CraftbookSetupNeeds = Pick<Craftbook, 'models' | 'services'>;

/** On-device engines Gezel downloads chat-model weights into. */
export const CRAFTBOOK_MODEL_ENGINES = ['llama-cpp', 'mlx', 'ds4'] as const;
export type CraftbookModelEngine = (typeof CRAFTBOOK_MODEL_ENGINES)[number];

export function isCraftbookModelEngine(value: string): value is CraftbookModelEngine {
  return (CRAFTBOOK_MODEL_ENGINES as readonly string[]).includes(value);
}

export interface ResolvedCraftbookModelNeed {
  id: string;
  provider: CraftbookModelEngine;
  reasons: string[];
}

/**
 * Resolve each model need for one run: `{{param}}` references take the run's
 * value, else the `paramSchema` default. A need whose id resolves to nothing
 * is dropped (an optional model nobody asked for), as is one on a hosted
 * provider (nothing to download). Duplicates merge, keeping every reason.
 */
export function resolveCraftbookModelNeeds(
  models: readonly CraftbookModelNeed[] | undefined,
  opts: {
    params?: Readonly<Record<string, string>>;
    paramSchema?: Craftbook['paramSchema'];
    /** The engine a need without a provider means on this computer. */
    defaultProvider: CraftbookModelEngine;
  },
): ResolvedCraftbookModelNeed[] {
  const context = { ...craftbookParamDefaults(opts.paramSchema), ...opts.params };
  const resolve = (value: string): string | undefined => {
    const out = interpolateContext(value, context).trim();
    return out && !out.includes('{{') ? out : undefined;
  };
  const byKey = new Map<string, ResolvedCraftbookModelNeed>();
  for (const need of models ?? []) {
    const id = resolve(need.id);
    if (!id) continue;
    const provider = (need.provider && resolve(need.provider)) || opts.defaultProvider;
    if (!isCraftbookModelEngine(provider)) continue;
    const key = `${provider}:${id}`;
    const entry = byKey.get(key) ?? { id, provider, reasons: [] };
    if (need.reason && !entry.reasons.includes(need.reason)) entry.reasons.push(need.reason);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

export type CraftbookSetupGap =
  | { kind: 'external-services'; reasons: string[] }
  /** No keyed web search. `keyMissing` false means the key is saved but Brave is not selected. */
  | { kind: 'web-search'; keyMissing: boolean; reasons: string[] }
  | { kind: 'model'; id: string; provider: CraftbookModelEngine; reasons: string[] };

export interface CraftbookSetupState {
  /** `resolveSecurityPolicy(config).allowExternalServices`. */
  allowExternalServices: boolean;
  /** `config.webSearch.provider`; absent is the zero-key Wikipedia default. */
  webSearchProvider?: string;
  hasBraveSearchApiKey: boolean;
  /** Installed model ids per engine. */
  installedModels: Partial<Record<CraftbookModelEngine, readonly string[]>>;
}

/**
 * The gaps between a run's needs and this Gezel, in the order a host should
 * close them: External services first (web search cannot work without it),
 * then web search, then downloads. Empty means ready.
 */
export function craftbookSetupGaps(
  needs: {
    services?: readonly CraftbookServiceNeed[];
    models?: readonly ResolvedCraftbookModelNeed[];
  },
  state: CraftbookSetupState,
): CraftbookSetupGap[] {
  const services = needs.services ?? [];
  const reasonsOf = (list: readonly CraftbookServiceNeed[]) => [
    ...new Set(list.map((need) => need.reason).filter((reason): reason is string => !!reason)),
  ];
  const gaps: CraftbookSetupGap[] = [];
  if (services.length > 0 && !state.allowExternalServices) {
    gaps.push({ kind: 'external-services', reasons: reasonsOf(services) });
  }
  const webSearch = services.filter((need) => need.kind === 'web-search');
  if (webSearch.length > 0 && !webSearchConfigured(state)) {
    gaps.push({
      kind: 'web-search',
      keyMissing: !state.hasBraveSearchApiKey,
      reasons: reasonsOf(webSearch),
    });
  }
  for (const model of needs.models ?? []) {
    if (state.installedModels[model.provider]?.includes(model.id)) continue;
    gaps.push({ kind: 'model', ...model });
  }
  return gaps;
}

/** Brave with its key is the one real web search; `mock` stands in for it in tests. */
function webSearchConfigured(state: CraftbookSetupState): boolean {
  if (state.webSearchProvider === 'mock') return true;
  return state.webSearchProvider === 'brave' && state.hasBraveSearchApiKey;
}
