/**
 * Before `gezel do` runs a craftbook (or a workflow module asks through
 * `context.ensureSetup`), make sure this Gezel can do what the book needs:
 * External services on, a working web search, its chat models downloaded.
 *
 * At a terminal each missing piece is offered as one question; anywhere
 * else the run stops before it starts and names the commands that fix it.
 * WHY: a batch run used to find these one at a time, each a failed run —
 * or hours in, at the first model call or search.
 */
import { Writable } from 'node:stream';
import {
  type ChatModelManifest,
  type Craftbook,
  type CraftbookModelEngine,
  type CraftbookSetupGap,
  type CraftbookSetupNeeds,
  type CraftbookSetupState,
  type NativeEngineName,
  type ResolvedCraftbookModelNeed,
  craftbookSetupGaps,
  isCraftbookModelEngine,
  resolveCraftbookModelNeeds,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { ConfigResponse, GezelClient } from '@bendyline/gezel-client/node';
import { resolveOnDeviceProvider } from '@bendyline/gezel/native';
import { CliError } from './connection.js';
import { formatGb, pullChatModel } from './model-pull.js';
import { installNativeToolkit } from './native-command.js';
import { SECURITY_LEVEL_LABELS, policyWithExternalServices } from './settings-command.js';

export type CraftbookSetupClient = Pick<
  GezelClient,
  | 'getConfig'
  | 'updateConfig'
  | 'getCatalogItem'
  | 'checkModelDownloadSpace'
  | 'getNativeEngineStatus'
  | 'ensureNativeEngine'
  | 'listLlamaCppModels'
  | 'listMlxModels'
  | 'listDs4Models'
  | 'installLlamaCppModel'
  | 'installMlxModel'
  | 'installDs4Model'
  | 'toolWebSearch'
>;

/** How setup asks a person. `null` when nobody is at a terminal. */
export interface SetupPrompter {
  /** True only for an explicit yes. */
  confirm(question: string): Promise<boolean>;
  /** A value typed without echo; empty when the person just presses Enter. */
  secret(question: string): Promise<string>;
}

export interface CraftbookSetupOptions {
  projectId: string;
  /** Names the run in every message, e.g. the craftbook's name. */
  label: string;
  needs: CraftbookSetupNeeds;
  /** The run's parameters, for `{{param}}` model references. */
  params?: Readonly<Record<string, string>>;
  paramSchema?: Craftbook['paramSchema'];
  prompter: SetupPrompter | null;
  /** Status lines and download progress — stderr, so `--json` stdout stays clean. */
  write: (text: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
}

const BRAVE_KEY_URL = 'https://brave.com/search/api/';
const SEARCH_CHECK = { query: 'Gezel web search check', limit: 1 };

const ENGINE_BINARY: Record<CraftbookModelEngine, NativeEngineName> = {
  'llama-cpp': 'llama-server',
  mlx: 'uv',
  ds4: 'ds4-server',
};

/** Resolve without a return value when the run can start; throw a CliError naming what is missing when it cannot. */
export async function ensureCraftbookSetup(
  client: CraftbookSetupClient,
  options: CraftbookSetupOptions,
): Promise<void> {
  const services = options.needs.services ?? [];
  if (!options.needs.models?.length && services.length === 0) return;
  const config = await client.getConfig();
  const models = resolveCraftbookModelNeeds(options.needs.models, {
    ...(options.params ? { params: options.params } : {}),
    ...(options.paramSchema ? { paramSchema: options.paramSchema } : {}),
    defaultProvider: defaultModelEngine(config, options.platform, options.arch),
  });
  const gaps = craftbookSetupGaps(
    { services, models },
    await readSetupState(client, config, models),
  );
  if (gaps.length === 0) return;

  const sizes = await modelSizes(client, gaps);
  const lines = gaps.map((gap) => `  • ${describeGap(gap, sizes)}`);
  if (!options.prompter) {
    throw new CliError(
      [
        `${options.label} is not set up to run yet:`,
        ...lines,
        '',
        'Run the same command in a terminal to set it up step by step, or run:',
        ...instructions(gaps).map((line) => `  ${line}`),
      ].join('\n'),
    );
  }

  options.write(`${options.label} needs some setup first:\n${lines.join('\n')}\n\n`);
  const prompter = options.prompter;
  const stop = (from: CraftbookSetupGap): never => {
    const rest = gaps.slice(gaps.indexOf(from));
    throw new CliError(
      [
        `Not set up, so ${options.label} did not start. To finish later, run:`,
        ...instructions(rest).map((line) => `  ${line}`),
      ].join('\n'),
    );
  };

  for (const gap of gaps) {
    if (gap.kind === 'external-services') {
      const next = policyWithExternalServices(config, true);
      const from = SECURITY_LEVEL_LABELS[resolveSecurityPolicy(config).level];
      const to = SECURITY_LEVEL_LABELS[next.level];
      const change = from === to ? '' : ` This changes your security level from ${from} to ${to}.`;
      const yes = await prompter.confirm(
        `Turn on External services, so gezels can search the web and read web pages?${change} [y/N] `,
      );
      if (!yes) stop(gap);
      await client.updateConfig({ securityPolicy: next });
      options.write('External services: on\n');
    } else if (gap.kind === 'web-search') {
      if (gap.keyMissing) {
        options.write(
          `Web search needs a Brave Search API key. Get one at ${BRAVE_KEY_URL} — Gezel keeps it in this computer's secret store.\n`,
        );
        const key = (
          await prompter.secret('Paste the key (hidden), or press Enter to stop: ')
        ).trim();
        if (!key) stop(gap);
        await saveBraveKey(client, config, key, options.projectId);
        options.write('Web search: Brave (test search passed)\n');
      } else {
        const current = config.webSearch?.provider ?? 'wikipedia';
        const yes = await prompter.confirm(
          `A Brave Search key is saved, but web search uses ${current === 'wikipedia' ? 'Wikipedia' : current}. Switch web search to Brave? [y/N] `,
        );
        if (!yes) stop(gap);
        await client.updateConfig({ webSearch: { ...config.webSearch, provider: 'brave' } });
        options.write('Web search: Brave\n');
      }
    }
  }

  const downloads = gaps.filter((gap) => gap.kind === 'model');
  if (downloads.length > 0) {
    const total = downloads.reduce((sum, gap) => sum + (sizes.get(modelKey(gap)) ?? 0), 0);
    if (total > 0) {
      const space = await client.checkModelDownloadSpace({ sizeBytes: total });
      if (space.known && !space.ok) {
        throw new CliError(
          `The models need ${formatGb(space.requiredBytes)} GB, and Gezel model storage has ${formatGb(space.freeBytes)} GB free. Free some space, then run again.`,
        );
      }
    }
    const what = downloads.length === 1 ? 'this model' : `these ${downloads.length} models`;
    const yes = await prompter.confirm(
      `Download ${what} now? It is a one-time download${total > 0 ? ` of ${formatGb(total)} GB` : ''}. [y/N] `,
    );
    if (!yes) stop(downloads[0]!);
    await ensureEngines(
      client,
      downloads.map((gap) => gap.provider),
      options.write,
    );
    for (const gap of downloads) await pullChatModel(client, gap.provider, gap.id, options.write);
  }

  const after = craftbookSetupGaps(
    { services, models },
    await readSetupState(client, await client.getConfig(), models),
  );
  if (after.length > 0) {
    throw new CliError(
      [
        `${options.label} is still not set up:`,
        ...after.map((gap) => `  • ${describeGap(gap, sizes)}`),
      ].join('\n'),
    );
  }
  options.write('\n');
}

/** The prompter for the CLI's own terminal, or null when stdin/stderr is not one. */
export function terminalPrompter(): SetupPrompter | null {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  return {
    confirm: async (question) => /^(y|yes)$/i.test((await ask(question, false)).trim()),
    secret: (question) => ask(question, true),
  };
}

function ask(question: string, hidden: boolean): Promise<string> {
  // A muted output stream is how readline reads without echo: it still
  // drives the line editor, it just never draws the typed characters.
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  return import('node:readline').then(
    ({ createInterface }) =>
      new Promise<string>((resolve, reject) => {
        const rl = createInterface({ input: process.stdin, output, terminal: true });
        let settled = false;
        rl.on('SIGINT', () => {
          settled = true;
          rl.close();
          process.stderr.write('\n');
          reject(new CliError('Cancelled.'));
        });
        // Ctrl+D or a closed stdin ends the interface without an answer; left
        // pending, the promise held nothing and the CLI exited mid-question.
        rl.on('close', () => {
          if (settled) return;
          settled = true;
          process.stderr.write('\n');
          resolve('');
        });
        rl.question(question, (answer) => {
          settled = true;
          rl.close();
          if (hidden) process.stderr.write('\n');
          resolve(answer);
        });
        muted = hidden;
      }),
  );
}

function defaultModelEngine(
  config: ConfigResponse,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CraftbookModelEngine {
  const configured = config.provider;
  return configured && isCraftbookModelEngine(configured)
    ? configured
    : resolveOnDeviceProvider(platform, arch);
}

async function readSetupState(
  client: CraftbookSetupClient,
  config: ConfigResponse,
  models: readonly ResolvedCraftbookModelNeed[],
): Promise<CraftbookSetupState> {
  const engines = [...new Set(models.map((model) => model.provider))];
  const installed = await Promise.all(
    engines.map(async (engine) => {
      const { models: list } =
        engine === 'mlx'
          ? await client.listMlxModels()
          : engine === 'ds4'
            ? await client.listDs4Models()
            : await client.listLlamaCppModels();
      return [engine, list.map((model) => model.id)] as const;
    }),
  );
  return {
    allowExternalServices: resolveSecurityPolicy(config).allowExternalServices,
    ...(config.webSearch?.provider ? { webSearchProvider: config.webSearch.provider } : {}),
    hasBraveSearchApiKey: config.hasBraveSearchApiKey === true,
    installedModels: Object.fromEntries(installed),
  };
}

const modelKey = (model: { provider: string; id: string }) => `${model.provider}:${model.id}`;

/**
 * Download sizes for the missing models, from the catalog. A model the
 * catalog does not know cannot be downloaded at all, so that is said now
 * rather than after the person agreed to a download.
 */
async function modelSizes(
  client: CraftbookSetupClient,
  gaps: readonly CraftbookSetupGap[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const gap of gaps) {
    if (gap.kind !== 'model') continue;
    let manifest: ChatModelManifest;
    try {
      const item = await client.getCatalogItem('chat-model', gap.id);
      if (item.manifest.kind !== 'chat-model') throw new Error('not a chat model');
      manifest = item.manifest;
    } catch {
      throw new CliError(
        `This run needs the model ${gap.id}, which is not installed and is not in the model catalog. Check the model name.`,
      );
    }
    const source =
      gap.provider === 'mlx'
        ? manifest.mlx
        : gap.provider === 'ds4'
          ? manifest.ds4
          : manifest.llamaCpp;
    if (!source) {
      throw new CliError(
        `This run needs the model ${gap.id} on ${gap.provider}, and the catalog has no ${gap.provider} download for it.`,
      );
    }
    sizes.set(modelKey(gap), source.approxSizeBytes);
  }
  return sizes;
}

function describeGap(gap: CraftbookSetupGap, sizes: ReadonlyMap<string, number>): string {
  const why = gap.reasons.length > 0 ? ` (${gap.reasons.join('; ')})` : '';
  switch (gap.kind) {
    case 'external-services':
      return `External services are off, so gezels cannot reach the web${why}.`;
    case 'web-search':
      return gap.keyMissing
        ? `Web search needs a Brave Search API key, and none is set${why}.`
        : `Web search is not set to Brave Search${why}.`;
    case 'model': {
      const size = sizes.get(modelKey(gap));
      return `${gap.id} is not downloaded yet (${gap.provider}${size ? `, ${formatGb(size)} GB` : ''})${why}.`;
    }
  }
}

function instructions(gaps: readonly CraftbookSetupGap[]): string[] {
  const out: string[] = [];
  for (const gap of gaps) {
    if (gap.kind === 'external-services') out.push('gezel security external-services on');
    else if (gap.kind === 'web-search')
      out.push(
        `gezel secret set braveSearchApiKey --env BRAVE_SEARCH_API_KEY --use-for-search   (get a key at ${BRAVE_KEY_URL})`,
      );
    else out.push(`gezel model pull ${gap.id} --provider ${gap.provider}`);
  }
  return out;
}

/**
 * Save the key, select Brave, and prove it with one search. A key Brave
 * refuses is taken back out: leaving it would make the next run look set
 * up and fail at its first search instead.
 */
async function saveBraveKey(
  client: CraftbookSetupClient,
  config: ConfigResponse,
  key: string,
  projectId: string,
): Promise<void> {
  try {
    await client.updateConfig({
      braveSearchApiKey: key,
      webSearch: { ...config.webSearch, provider: 'brave' },
    });
  } catch {
    // A validation error can echo the request body; never print the key.
    throw new CliError('Could not save the key. Check the Gezel service, then run again.');
  }
  const failure = await client.toolWebSearch(projectId, SEARCH_CHECK).then(
    () => undefined,
    (error: unknown) => serviceErrorText(error),
  );
  if (failure === undefined) return;
  await client
    .updateConfig({ braveSearchApiKey: '', webSearch: { ...config.webSearch } })
    .catch(() => {});
  throw new CliError(
    `A test search with that key failed, so it was not kept: ${failure.replaceAll(key, '…')}\nCheck the key at ${BRAVE_KEY_URL}, then run again.`,
  );
}

/** The service's own words for a failed request, not the HTTP wrapper around them. */
function serviceErrorText(error: unknown): string {
  const details = (error as { details?: unknown } | null)?.details;
  if (details && typeof details === 'object') {
    const text = (details as { error?: unknown }).error;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/** A first download on a fresh machine also needs the engine that runs it. */
async function ensureEngines(
  client: CraftbookSetupClient,
  engines: readonly CraftbookModelEngine[],
  write: (text: string) => void,
): Promise<void> {
  const status = await client.getNativeEngineStatus();
  // Dev builds have no pinned release, and some platforms have no build;
  // the model's own first turn reports those better than a refused download.
  if (!status.pinned || !status.platformKey) return;
  const missing = [...new Set(engines.map((engine) => ENGINE_BINARY[engine]))].filter(
    (binary) => !status.engines.some((entry) => entry.name === binary && entry.installed),
  );
  if (missing.length === 0) return;
  await installNativeToolkit(client, { engines: missing, output: { writeProgress: write } });
}
