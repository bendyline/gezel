import {
  FIRST_USE_INDEXING_GRACE_MS,
  type GezelConfig,
  type Project,
  createLogger,
  firstUseAgeMs,
  isSharedLibraryProject,
  nowIso,
} from '@bendyline/gezel';
import { resolveDefaultProviderName } from '../providers/default-provider.js';
import { type LocalProviderName, isLocalProvider } from '../providers/native/engine-key.js';

const log = createLogger('index');

/** How long a held verdict stands before config and the model inventory are read again. */
const RECHECK_MS = 60_000;

export interface ChatModelReadinessDeps {
  config: GezelConfig;
  listInstalledModels: (provider: LocalProviderName) => Promise<readonly unknown[]>;
  hasCredential: (name: 'openaiApiKey' | 'anthropicApiKey') => Promise<boolean>;
  copilotAvailable: () => Promise<boolean>;
}

/**
 * Whether the default provider can answer a chat turn now. Deliberately does
 * not build a provider: building Copilot can cold-start its CLI for a minute,
 * and this is asked once a minute while a new install waits.
 */
export async function defaultProviderCanAnswer(deps: ChatModelReadinessDeps): Promise<boolean> {
  const provider = resolveDefaultProviderName(deps.config);
  if (isLocalProvider(provider)) return (await deps.listInstalledModels(provider)).length > 0;
  if (provider === 'openai') return deps.hasCredential('openaiApiKey');
  if (provider === 'anthropic') return deps.hasCredential('anthropicApiKey');
  if (provider === 'copilot') return deps.copilotAvailable();
  // The CLI providers, Ollama and the platform models are tools the person
  // chose and set up themselves; there is no download to wait for.
  return true;
}

/**
 * A folder the person handed gezel themselves. Their own folders are indexed
 * at once even during first use, because the first look at them ("12,480
 * photos from 2009 to 2026") is the answer to something they just asked for.
 */
export function isPersonsOwnFolder(project: HeldProject): boolean {
  return Boolean(project.workingDir) && !isSharedLibraryProject(project);
}

/** The two facts the hold reads from a project. */
export type HeldProject = Pick<Project, 'workingDir' | 'properties'>;

export interface FirstUseIndexingHoldOptions {
  readConfig: () => Promise<GezelConfig>;
  writeConfig: (patch: Partial<GezelConfig>) => Promise<unknown>;
  chatModelReady: () => Promise<boolean>;
  now?: () => number;
}

/**
 * Holds automatic background indexing on a new install until it has been in
 * use for half an hour and a chat model can answer, whichever comes later.
 * Explicit requests (a refresh route, a craftbook's readiness check, the
 * person's own folders) never wait. Releases once and stays released; an
 * install without `firstUseAt` is established and never held.
 */
export class FirstUseIndexingHold {
  private readonly readConfig: () => Promise<GezelConfig>;
  private readonly writeConfig: (patch: Partial<GezelConfig>) => Promise<unknown>;
  private readonly chatModelReady: () => Promise<boolean>;
  private readonly now: () => number;
  private released = false;
  /** The last verdict and when it was reached; null until the first one. */
  private verdict: { held: boolean; at: number } | null = null;
  private configRead: Promise<boolean> | null = null;
  /**
   * The model check runs on its own and is never awaited by a caller. The
   * inventory read behind it can take a minute on a machine with large
   * models, and neither a tick nor a shutdown should wait on it.
   */
  private modelCheck: Promise<void> | null = null;
  private announcedReason: string | null = null;

  constructor(opts: FirstUseIndexingHoldOptions) {
    this.readConfig = opts.readConfig;
    this.writeConfig = opts.writeConfig;
    this.chatModelReady = opts.chatModelReady;
    this.now = opts.now ?? Date.now;
  }

  /** Whether background indexing waits right now. */
  isActive(): Promise<boolean> {
    if (this.released) return Promise.resolve(false);
    // Still deciding whether a model can answer: a home that got this far is
    // past its half hour but not yet released, so it keeps waiting.
    if (this.modelCheck) return Promise.resolve(true);
    const now = this.now();
    if (this.verdict && now - this.verdict.at < RECHECK_MS) {
      return Promise.resolve(this.verdict.held);
    }
    this.configRead ??= this.check(now).finally(() => {
      this.configRead = null;
    });
    return this.configRead;
  }

  /** Whether background indexing skips this project right now. */
  async holds(project: HeldProject | null | undefined): Promise<boolean> {
    if (project && isPersonsOwnFolder(project)) return false;
    return this.isActive();
  }

  private async check(now: number): Promise<boolean> {
    let config: GezelConfig;
    try {
      config = await this.readConfig();
    } catch {
      // An unreadable config must not stop an established install indexing.
      this.verdict = { held: false, at: now };
      return false;
    }
    const age = firstUseAgeMs(config.firstUseAt, now);
    if (age === null || config.firstUseIndexingReleasedAt) {
      this.released = true;
      return false;
    }
    if (age < FIRST_USE_INDEXING_GRACE_MS) return this.hold('in the first half hour of use', now);
    this.modelCheck = this.checkModel(age).finally(() => {
      this.modelCheck = null;
    });
    return true;
  }

  private async checkModel(age: number): Promise<void> {
    const ready = await this.chatModelReady().catch(() => false);
    if (!ready) {
      this.hold('until a chat model is ready', this.now());
      return;
    }
    this.released = true;
    log.info(`[index] background indexing starts, ${Math.round(age / 60_000)} min after first use`);
    await this.writeConfig({ firstUseIndexingReleasedAt: nowIso() }).catch((err: unknown) =>
      log.warn(`[index] could not record the first-use release: ${String(err)}`),
    );
  }

  private hold(reason: string, at: number): boolean {
    this.verdict = { held: true, at };
    if (this.announcedReason !== reason) {
      this.announcedReason = reason;
      log.info(`[index] background indexing waits ${reason}`);
    }
    return true;
  }
}
