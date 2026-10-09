import {
  type GezelConfig,
  type MediaSearchStatusResponse,
  createLogger,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import { locateFfmpeg } from '../media/ffmpeg.js';
import { imageTokenBudget } from '../memory/image-embed-core.js';
import { setAudioVideoGate, setMediaSearchGate } from '../memory/image-embeddings.js';
import {
  MEDIA_SEARCH_PROFILE,
  type MediaModelPart,
  installMediaModel,
  installedMediaParts,
  mediaModelBytes,
  mediaModelCacheDir,
} from './install.js';

const log = createLogger('media-search');

/** Disabled by the operator for the process, whatever the setting says. */
function disabledByEnv(): boolean {
  const raw = process.env.GEZEL_DISABLE_IMAGE_EMBEDDINGS?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Search photos, video and audio by meaning: the setting (on unless turned
 * off), the model's install state, downloads (only when the security policy
 * allows app network), and the gate the media embed tier reads. The audio
 * encoder installs only when audio or video work first needs it.
 */
export class MediaSearchManager {
  private job: {
    parts: MediaModelPart[];
    bytesDone: number;
    bytesTotal: number;
    error?: string;
  } | null = null;

  constructor(
    private readonly opts: {
      home: string;
      readConfig: () => Promise<GezelConfig | null>;
      fetchImpl?: typeof fetch;
      /**
       * Whether boot and the indexing tier may start the download on their
       * own. Off where first-boot background downloads are (see
       * {@link backgroundDownloadsAllowed}); turning media search on in
       * Settings still installs.
       */
      backgroundDownloads?: boolean;
    },
  ) {}

  private cacheDir(): string {
    return mediaModelCacheDir(this.opts.home);
  }

  async setting(): Promise<{ enabled: boolean; imageTokenBudget: number }> {
    const config = await this.opts.readConfig().catch(() => null);
    const budget = config?.mediaSearch?.imageTokenBudget;
    return {
      enabled: !disabledByEnv() && config?.mediaSearch?.enabled !== false,
      imageTokenBudget: budget ?? MEDIA_SEARCH_PROFILE.media?.image?.tokenBudget ?? 280,
    };
  }

  async status(): Promise<MediaSearchStatusResponse> {
    const setting = await this.setting();
    const parts = await installedMediaParts(this.cacheDir());
    const ready = parts.has('text') && parts.has('vision');
    let status: MediaSearchStatusResponse['status'];
    if (!setting.enabled) status = 'off';
    else if (this.job && !this.job.error) status = 'downloading';
    else if (this.job?.error) status = 'error';
    else if (!ready) status = (await this.networkAllowed()) ? 'not-installed' : 'blocked-network';
    else status = 'ready';
    const ffmpeg = await locateFfmpeg();
    return {
      enabled: setting.enabled,
      status,
      profileId: MEDIA_SEARCH_PROFILE.id,
      installedParts: [...parts],
      imageTokenBudget: setting.imageTokenBudget,
      approxBytes: {
        images: mediaModelBytes(['text', 'vision']),
        audio: mediaModelBytes(['audio']),
      },
      ...(this.job && !this.job.error
        ? { progress: { bytesDone: this.job.bytesDone, bytesTotal: this.job.bytesTotal } }
        : {}),
      ...(this.job?.error ? { error: this.job.error } : {}),
      ffmpeg: ffmpeg ? { path: ffmpeg.path, version: ffmpeg.version } : null,
    };
  }

  /** Download parts in the background (network permitting); text always comes along. */
  async install(
    parts: MediaModelPart[] = ['text', 'vision'],
  ): Promise<{ started: boolean; installed?: boolean; reason?: string }> {
    const have = await installedMediaParts(this.cacheDir());
    const wanted = [...new Set<MediaModelPart>(['text', ...parts])];
    if (wanted.every((p) => have.has(p))) {
      await this.applyGate();
      return { started: false, installed: true };
    }
    if (this.job && !this.job.error) return { started: true };
    if (!(await this.networkAllowed())) {
      await this.applyGate();
      return { started: false, reason: 'app network access is off in Security settings' };
    }
    const missing = wanted.filter((p) => !have.has(p));
    this.job = { parts: missing, bytesDone: 0, bytesTotal: mediaModelBytes(missing) };
    void (async () => {
      const opts = this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {};
      for await (const event of installMediaModel(this.cacheDir(), wanted, opts)) {
        if (event.type === 'progress' && this.job) {
          this.job.bytesDone = event.bytesDone;
          this.job.bytesTotal = event.bytesTotal;
        } else if (event.type === 'error' && this.job) {
          this.job.error = event.error;
          log.warn(`[media-search] model download failed: ${event.error}`);
          return;
        }
      }
      this.job = null;
      log.info(`[media-search] installed ${missing.join(', ')}`);
      await this.applyGate();
    })().catch((err) => {
      if (this.job) this.job.error = err instanceof Error ? err.message : String(err);
    });
    return { started: true };
  }

  /**
   * The audio encoder, for the first audio or video file the media tier
   * meets. Only with the setting on and an ffmpeg to decode with.
   */
  async ensureAudio(): Promise<boolean> {
    if (!(await this.setting()).enabled || !(await locateFfmpeg())) return false;
    const parts = await installedMediaParts(this.cacheDir());
    if (parts.has('audio')) {
      await this.applyGate();
      return true;
    }
    if (this.opts.backgroundDownloads !== false) await this.install(['text', 'vision', 'audio']);
    return false;
  }

  /** Bring disk and gate in line with the setting; `install: false` only gates. */
  async reconcile(opts: { install?: boolean } = {}): Promise<void> {
    const setting = await this.setting();
    process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET = String(setting.imageTokenBudget);
    await this.applyGate();
    if (setting.enabled && opts.install !== false) await this.install();
  }

  /** Deferred boot step: log what is resolved, then reconcile. */
  async bootWarm(): Promise<void> {
    const setting = await this.setting();
    const parts = await installedMediaParts(this.cacheDir());
    log.info(
      `[media-search] resolved enabled=${setting.enabled} profile=${MEDIA_SEARCH_PROFILE.id} budget=${setting.imageTokenBudget} installed=${[...parts].join(',') || 'none'}`,
    );
    await this.reconcile({ install: this.opts.backgroundDownloads !== false });
  }

  /** Open or close the media embed tiers to match the setting, the files on disk and ffmpeg. */
  async applyGate(): Promise<void> {
    const setting = await this.setting();
    const parts = await installedMediaParts(this.cacheDir());
    if (!setting.enabled) setMediaSearchGate('media search is off in Settings');
    else if (!parts.has('text') || !parts.has('vision'))
      setMediaSearchGate('the media search model is not installed yet');
    else setMediaSearchGate(null);
    if (!setting.enabled) setAudioVideoGate('media search is off in Settings');
    else if (!(await locateFfmpeg()))
      setAudioVideoGate('no ffmpeg found (set GEZEL_FFMPEG, or install ffmpeg on PATH)');
    else if (!parts.has('audio'))
      setAudioVideoGate('the audio part of the media search model is not installed yet');
    else setAudioVideoGate(null);
    if (imageTokenBudget() !== setting.imageTokenBudget) {
      process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET = String(setting.imageTokenBudget);
    }
  }

  private async networkAllowed(): Promise<boolean> {
    const config = await this.opts.readConfig().catch(() => null);
    return config ? resolveSecurityPolicy(config).allowAppNetwork : true;
  }
}

/**
 * Whether boot may fetch the model unasked: not where first-boot background
 * downloads are skipped (`GEZEL_SKIP_SYSTEM_BOOTSTRAP=1`, the mock provider),
 * and never inside a test run. A test that booted the service for longer
 * than the boot-warm delay fetched half the model into the shared test cache,
 * and that partial install is what hung the image-embed tests.
 */
export function backgroundDownloadsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(
    env.GEZEL_SKIP_SYSTEM_BOOTSTRAP === '1' ||
    env.GEZEL_MOCK_PROVIDER === '1' ||
    Boolean(env.VITEST)
  );
}
