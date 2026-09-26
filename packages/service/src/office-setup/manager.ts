import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ConfigureOfficeRequest,
  GEZEL_VERSION,
  OFFICE_APPS,
  OFFICE_APP_LABELS,
  type OfficeApp,
  type OfficeHostReport,
  type OfficeSetupStatusResponse,
  createLogger,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import {
  SecurityStateCorruptionError,
  readSecurityJson,
  writeSecurityJson,
} from '../fs/security-json.js';
import { HarnessSetupError, createMutationQueue, ensurePrivateDir } from '../local-harness/base.js';
import type { OfficeHostListener } from '../office-host/listener.js';
import {
  type OfficeIdentity,
  loadOrCreateOfficeIdentity,
  officeCaLabelForHome,
} from '../office-host/tls-identity.js';
import { type OfficeDetection, detectOffice } from './detect.js';
import { buildOfficeManifest } from './manifest.js';

const log = createLogger('office-setup');

const STATE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Registration {
  registered: boolean;
  reportedAt: string;
  error?: string;
}

interface SetupState {
  version: 1;
  /** Apps the user chose. */
  apps: OfficeApp[];
  /** One GUID per app, minted once per home so Office sees the same add-in forever. */
  manifestIds: Record<OfficeApp, string>;
  /** sha256 of each selected app's manifest as last written. */
  manifestDigests: Partial<Record<OfficeApp, string>>;
  caSha256: string;
  trust: { installed: boolean | null; reportedAt?: string; error?: string };
  registrations: Partial<Record<OfficeApp, Registration>>;
  createdAt: string;
  updatedAt: string;
}

export class OfficeSetupError extends HarnessSetupError {
  constructor(code: string, message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(code, message, status);
    this.name = 'OfficeSetupError';
  }
}

export interface OfficeSetupManager {
  status(): Promise<OfficeSetupStatusResponse>;
  configure(input: ConfigureOfficeRequest): Promise<OfficeSetupStatusResponse>;
  /** The desktop app reports what it did in the user's OS profile. */
  recordHostReport(report: OfficeHostReport): Promise<OfficeSetupStatusResponse>;
  remove(): Promise<OfficeSetupStatusResponse>;
  /** Boot / config-change / daily: renew the leaf, rebind, refresh manifests. */
  reconcile(): Promise<void>;
  /** The live Office origin, or null. */
  origin(): string | null;
  stop(): Promise<void>;
}

export interface CreateOfficeSetupManagerOptions {
  home: string;
  listener: OfficeHostListener;
  /** Whether this build ships the task-pane pages (`dist/office`). */
  paneAvailable: () => boolean;
  version?: string;
  platform?: NodeJS.Platform;
  detect?: () => Promise<OfficeDetection>;
  now?: () => Date;
  reconcileIntervalMs?: number;
}

export function createOfficeSetupManager(
  opts: CreateOfficeSetupManagerOptions,
): OfficeSetupManager {
  const platform = opts.platform ?? process.platform;
  const hostSupported = platform === 'darwin' || platform === 'win32';
  const integrationDir = join(opts.home, 'integrations', 'office');
  const manifestsDir = join(integrationDir, 'manifests');
  const statePath = join(integrationDir, 'setup.json');
  const now = opts.now ?? (() => new Date());
  const detect = opts.detect ?? (() => detectOffice({ platform }));
  const version = opts.version ?? GEZEL_VERSION;
  const label = officeCaLabelForHome(opts.home);
  const serialize = createMutationQueue();
  let identity: OfficeIdentity | null = null;
  let poller: ReturnType<typeof setInterval> | undefined;
  let closing = false;

  const manifestPath = (app: OfficeApp) => join(manifestsDir, `gezel-${app}.xml`);

  const readState = (): Promise<SetupState | null> =>
    readSecurityJson(statePath, 'Office setup', decodeSetupState);

  const writeState = (state: SetupState) =>
    writeSecurityJson(statePath, `${JSON.stringify(state, null, 2)}\n`);

  async function loadIdentity(): Promise<OfficeIdentity> {
    identity = await loadOrCreateOfficeIdentity({ dir: integrationDir, label, now: now() });
    return identity;
  }

  /** Write each selected app's manifest; drop the rest. Returns the new digests. */
  async function writeManifests(
    state: Pick<SetupState, 'apps' | 'manifestIds'>,
    origin: string,
  ): Promise<Partial<Record<OfficeApp, string>>> {
    await mkdir(manifestsDir, { recursive: true });
    const digests: Partial<Record<OfficeApp, string>> = {};
    for (const app of OFFICE_APPS) {
      if (!state.apps.includes(app)) {
        await rm(manifestPath(app), { force: true });
        continue;
      }
      const xml = buildOfficeManifest({ app, origin, id: state.manifestIds[app], version });
      await writeFileAtomic(manifestPath(app), xml, { durable: true });
      digests[app] = createHash('sha256').update(xml).digest('hex');
    }
    return digests;
  }

  /** Registrations survive only for apps whose manifest did not change. */
  function carryRegistrations(
    prior: SetupState | null,
    apps: readonly OfficeApp[],
    digests: Partial<Record<OfficeApp, string>>,
  ): Partial<Record<OfficeApp, Registration>> {
    const out: Partial<Record<OfficeApp, Registration>> = {};
    for (const app of apps) {
      const previous = prior?.registrations[app];
      if (previous && prior?.manifestDigests[app] === digests[app]) out[app] = previous;
    }
    return out;
  }

  function startPoller(): void {
    if (poller || closing) return;
    poller = setInterval(() => {
      void manager
        .reconcile()
        .catch((err) => log.warn(`[office-setup] reconcile failed: ${String(err)}`));
    }, opts.reconcileIntervalMs ?? DAY_MS);
    poller.unref?.();
  }

  async function buildStatus(): Promise<OfficeSetupStatusResponse> {
    const detection = await detect().catch(() => ({
      hostSupported,
      apps: { word: false, excel: false, powerpoint: false },
    }));
    const listener = opts.listener.status();
    const paneAvailable = opts.paneAvailable();
    const base = {
      hostSupported,
      officeInstalled: OFFICE_APPS.some((app) => detection.apps[app]),
      listener,
      canConfigure: hostSupported && paneAvailable,
    };
    let state: SetupState | null;
    try {
      state = await readState();
    } catch (err) {
      if (!(err instanceof SecurityStateCorruptionError)) throw err;
      return {
        ...base,
        state: 'conflict',
        reasons: ['The Office setup record is damaged. Remove it and set Office up again.'],
        apps: OFFICE_APPS.map((app) => ({
          app,
          label: OFFICE_APP_LABELS[app],
          detected: detection.apps[app],
          selected: false,
          registered: null,
        })),
        trust: { installed: null },
        canRemove: true,
      };
    }
    if (state && !identity) {
      // After a restart, before reconcile has run: the desktop app still
      // needs the CA to install. The files exist whenever the state does.
      await loadIdentity().catch((err) =>
        log.warn(`[office-setup] identity load failed: ${String(err)}`),
      );
    }
    const apps = OFFICE_APPS.map((app) => {
      const selected = state?.apps.includes(app) ?? false;
      const reg = state?.registrations[app];
      return {
        app,
        label: OFFICE_APP_LABELS[app],
        detected: detection.apps[app],
        selected,
        ...(state ? { manifestId: state.manifestIds[app] } : {}),
        ...(state && selected ? { manifestPath: manifestPath(app) } : {}),
        registered: reg ? reg.registered : null,
        ...(reg?.error ? { error: reg.error } : {}),
      };
    });
    const ca = identity?.ca;
    const trust = {
      ...(ca
        ? {
            caPem: ca.pem,
            caSha256: ca.sha256Hex,
            caSha1: ca.sha1Hex,
            caCommonName: ca.commonName,
            ...(identity ? { leafPem: identity.leaf.certPem } : {}),
          }
        : {}),
      installed: state?.trust.installed ?? null,
      ...(state?.trust.error ? { error: state.trust.error } : {}),
      ...(state?.trust.reportedAt ? { reportedAt: state.trust.reportedAt } : {}),
    };
    if (!hostSupported) {
      return {
        ...base,
        state: 'unavailable',
        reasons: [],
        message: 'Word, Excel and PowerPoint add-ins are available on Windows and macOS.',
        apps,
        trust,
        canRemove: state !== null,
      };
    }
    if (!state) {
      return {
        ...base,
        state: paneAvailable ? 'not-configured' : 'unavailable',
        reasons: [],
        ...(paneAvailable
          ? {}
          : { message: 'This Gezel build does not include the Office pages.' }),
        apps,
        trust,
        canRemove: false,
      };
    }
    const reasons: string[] = [];
    if (listener.state !== 'listening') {
      reasons.push(listener.message ?? 'The Office connection is not running.');
    }
    if (state.trust.installed === false) {
      reasons.push(
        state.trust.error
          ? `This computer does not trust Gezel's Office certificate yet: ${state.trust.error}`
          : "This computer does not trust Gezel's Office certificate yet.",
      );
    } else if (state.trust.installed === null) {
      reasons.push("Open the Gezel desktop app to trust Gezel's Office certificate.");
    }
    for (const app of apps) {
      if (!app.selected) continue;
      if (app.registered === false) {
        reasons.push(`${app.label} is not set up yet${app.error ? `: ${app.error}` : '.'}`);
      } else if (app.registered === null) {
        reasons.push(`Open the Gezel desktop app to add Gezel to ${app.label}.`);
      }
    }
    return {
      ...base,
      state: reasons.length > 0 ? 'update-needed' : 'configured',
      reasons,
      apps,
      trust,
      ...(identity ? { leafNotAfter: identity.leaf.notAfter } : {}),
      canRemove: true,
    };
  }

  const manager: OfficeSetupManager = {
    status: () => buildStatus(),

    configure: (input) =>
      serialize(async () => {
        if (!hostSupported) {
          throw new OfficeSetupError(
            'office_unsupported',
            'Word, Excel and PowerPoint add-ins are available on Windows and macOS.',
            400,
          );
        }
        if (!opts.paneAvailable()) {
          throw new OfficeSetupError(
            'office_pages_missing',
            'This Gezel build does not include the Office pages.',
          );
        }
        await ensurePrivateDir(integrationDir);
        const prior = await readState().catch(() => null);
        const firstRun = prior === null;
        try {
          const id = await loadIdentity();
          const listen = await opts.listener.start(id.leaf);
          const origin = opts.listener.origin();
          if (listen.state !== 'listening' || !origin) {
            throw new OfficeSetupError(
              'office_port_in_use',
              listen.message ?? 'The Office connection could not start.',
            );
          }
          const manifestIds = { ...fillManifestIds(prior?.manifestIds) };
          const apps = OFFICE_APPS.filter((app) => input.apps.includes(app));
          const digests = await writeManifests({ apps, manifestIds }, origin);
          const caChanged = !prior || prior.caSha256 !== id.ca.sha256Hex;
          const stamp = now().toISOString();
          await writeState({
            version: STATE_VERSION,
            apps,
            manifestIds,
            manifestDigests: digests,
            caSha256: id.ca.sha256Hex,
            trust: caChanged ? { installed: null } : prior.trust,
            registrations: carryRegistrations(prior, apps, digests),
            createdAt: prior?.createdAt ?? stamp,
            updatedAt: stamp,
          });
          startPoller();
        } catch (err) {
          if (firstRun) {
            await opts.listener.stop().catch(() => {});
            await rm(integrationDir, { recursive: true, force: true }).catch(() => {});
            identity = null;
          }
          throw err;
        }
        return buildStatus();
      }),

    recordHostReport: (report) =>
      serialize(async () => {
        const state = await readState();
        if (!state)
          throw new OfficeSetupError('office_not_configured', 'Office is not set up.', 404);
        const stamp = now().toISOString();
        if (report.trust) {
          state.trust = {
            installed: report.trust.installed,
            reportedAt: stamp,
            ...(report.trust.error ? { error: report.trust.error } : {}),
          };
        }
        for (const app of OFFICE_APPS) {
          const r = report.apps?.[app];
          if (!r) continue;
          state.registrations[app] = {
            registered: r.registered,
            reportedAt: stamp,
            ...(r.error ? { error: r.error } : {}),
          };
        }
        state.updatedAt = stamp;
        await writeState(state);
        return buildStatus();
      }),

    remove: () =>
      serialize(async () => {
        await opts.listener.stop();
        await rm(integrationDir, { recursive: true, force: true });
        identity = null;
        if (poller) clearInterval(poller);
        poller = undefined;
        return buildStatus();
      }),

    reconcile: () =>
      serialize(async () => {
        if (closing) return;
        let state: SetupState | null;
        try {
          state = await readState();
        } catch (err) {
          log.warn(`[office-setup] setup record unreadable: ${String(err)}`);
          return;
        }
        if (!state || !hostSupported || !opts.paneAvailable()) {
          await opts.listener.stop();
          return;
        }
        const id = await loadIdentity();
        const listen = await opts.listener.start(id.leaf);
        const origin = opts.listener.origin();
        if (listen.state !== 'listening' || !origin) return;
        const digests = await writeManifests(state, origin);
        const caChanged = state.caSha256 !== id.ca.sha256Hex;
        const changed =
          caChanged || OFFICE_APPS.some((app) => digests[app] !== state!.manifestDigests[app]);
        if (changed) {
          const next: SetupState = {
            ...state,
            manifestDigests: digests,
            caSha256: id.ca.sha256Hex,
            trust: caChanged ? { installed: null } : state.trust,
            registrations: carryRegistrations(state, state.apps, digests),
            updatedAt: now().toISOString(),
          };
          await writeState(next);
        }
        startPoller();
      }),

    origin: () => opts.listener.origin(),

    stop: async () => {
      closing = true;
      if (poller) clearInterval(poller);
      poller = undefined;
      await opts.listener.stop();
    },
  };
  return manager;
}

function fillManifestIds(
  prior: Partial<Record<OfficeApp, string>> | undefined,
): Record<OfficeApp, string> {
  const out = {} as Record<OfficeApp, string>;
  for (const app of OFFICE_APPS) out[app] = prior?.[app] ?? randomUUID();
  return out;
}

function decodeSetupState(raw: string): SetupState {
  const parsed = JSON.parse(raw) as Partial<SetupState>;
  const isApp = (v: unknown): v is OfficeApp =>
    typeof v === 'string' && (OFFICE_APPS as readonly string[]).includes(v);
  if (
    parsed.version !== STATE_VERSION ||
    !Array.isArray(parsed.apps) ||
    !parsed.apps.every(isApp) ||
    !parsed.manifestIds ||
    !OFFICE_APPS.every((app) => typeof parsed.manifestIds?.[app] === 'string') ||
    typeof parsed.caSha256 !== 'string' ||
    !parsed.trust ||
    !(parsed.trust.installed === null || typeof parsed.trust.installed === 'boolean') ||
    typeof parsed.registrations !== 'object' ||
    parsed.registrations === null ||
    typeof parsed.manifestDigests !== 'object' ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string'
  ) {
    throw new Error('invalid Office setup record');
  }
  return parsed as SetupState;
}
