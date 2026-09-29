import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import type {
  LibreOfficeSetupStatusResponse,
  OfficeHostReport,
  OfficeSetupStatusResponse,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import * as lo from './libreoffice-register.js';
import * as office from './office-register.js';
import type { OfficeApp } from './office-register.js';
import * as trust from './trust-store.js';

/**
 * The desktop app's half of the Office and LibreOffice integrations. The
 * daemon owns certificates, the listener, manifests, and the `.oxt`; these
 * functions perform the steps that touch the user's OS profile and report
 * each outcome back, so the Settings card always shows the real state.
 *
 * Rule: a certificate is installed only from `enable`/`repair`, which run
 * in response to a click. `verify` (boot, card refresh) observes and
 * reports; the only change it makes on its own is refreshing a manifest
 * copy gezel already placed, which never prompts.
 */

type Integrations = GezelClient['officeIntegrations'];
/** The public methods only, so a plain object can stand in for it in tests. */
export type OfficeIntegrationClient = { [K in keyof Integrations]: Integrations[K] };

export interface OfficeIntegrationDeps {
  trust?: Partial<typeof trust>;
  office?: Partial<typeof office>;
  lo?: Partial<typeof lo>;
  homedir?: string;
  platform?: NodeJS.Platform;
}

function mods(deps: OfficeIntegrationDeps) {
  return {
    trust: { ...trust, ...deps.trust },
    office: { ...office, ...deps.office },
    lo: { ...lo, ...deps.lo },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function anchorOf(status: OfficeSetupStatusResponse): trust.TrustAnchor | null {
  const t = status.trust;
  if (!t.caPem || !t.caSha1 || !t.caCommonName) return null;
  return {
    caPem: t.caPem,
    sha1Hex: t.caSha1,
    commonName: t.caCommonName,
    ...(t.leafPem ? { leafPem: t.leafPem } : {}),
  };
}

function registrationOf(
  app: OfficeSetupStatusResponse['apps'][number],
): office.OfficeRegistration | null {
  if (!app.manifestId || !app.manifestPath) return null;
  return { app: app.app as OfficeApp, manifestId: app.manifestId, manifestPath: app.manifestPath };
}

// ── Office ────────────────────────────────────────────────────────────────

export async function enableOffice(
  client: OfficeIntegrationClient,
  apps: OfficeApp[],
  deps: OfficeIntegrationDeps = {},
): Promise<OfficeSetupStatusResponse> {
  const m = mods(deps);
  const status = await client.configureOffice({ apps });
  const report: OfficeHostReport = { apps: {} };

  const anchor = anchorOf(status);
  if (anchor) {
    try {
      if (!(await m.trust.isTrusted(anchor))) await m.trust.installTrust(anchor);
      const installed = await m.trust.isTrusted(anchor);
      report.trust = installed
        ? { installed: true }
        : {
            installed: false,
            error: 'The certificate was not trusted. Try again and approve the system prompt.',
          };
    } catch (err) {
      report.trust = { installed: false, error: message(err) };
    }
  }

  for (const app of status.apps) {
    const reg = registrationOf(app);
    try {
      if (app.selected && reg) {
        await m.office.registerOfficeAddin(reg);
        report.apps![reg.app] = { registered: await m.office.isOfficeAddinRegistered(reg) };
      } else if (app.manifestId) {
        await m.office.unregisterOfficeAddin({
          app: app.app as OfficeApp,
          manifestId: app.manifestId,
        });
      }
    } catch (err) {
      if (app.selected)
        report.apps![app.app as OfficeApp] = { registered: false, error: message(err) };
    }
  }
  return client.reportOfficeHost(report);
}

/** Re-run every step for the apps already chosen. */
export async function repairOffice(
  client: OfficeIntegrationClient,
  deps: OfficeIntegrationDeps = {},
): Promise<OfficeSetupStatusResponse> {
  const current = await client.getOfficeSetupStatus();
  const apps = current.apps.filter((a) => a.selected).map((a) => a.app as OfficeApp);
  if (apps.length === 0) throw new Error('Choose at least one Office app first.');
  return enableOffice(client, apps, deps);
}

export async function disableOffice(
  client: OfficeIntegrationClient,
  deps: OfficeIntegrationDeps = {},
): Promise<OfficeSetupStatusResponse> {
  const m = mods(deps);
  const status = await client.getOfficeSetupStatus();
  const problems: string[] = [];
  for (const app of status.apps) {
    if (!app.manifestId) continue;
    await m.office
      .unregisterOfficeAddin({ app: app.app as OfficeApp, manifestId: app.manifestId })
      .catch((err) => problems.push(`${app.label}: ${message(err)}`));
  }
  const anchor = anchorOf(status);
  if (anchor) await m.trust.uninstallTrust(anchor).catch((err) => problems.push(message(err)));
  const removed = await client.removeOfficeSetup();
  if (problems.length > 0) {
    return {
      ...removed,
      message: `Gezel was removed, but some cleanup did not finish: ${problems.join('; ')}`,
    };
  }
  return removed;
}

/**
 * Observe and report: is the CA trusted, is each chosen app registered. A
 * macOS manifest copy gezel already placed is refreshed when the daemon's
 * manifest changed (an upgrade), because Office reads the copy, not ours.
 */
export async function verifyOffice(
  client: OfficeIntegrationClient,
  deps: OfficeIntegrationDeps = {},
): Promise<OfficeSetupStatusResponse> {
  const m = mods(deps);
  const status = await client.getOfficeSetupStatus();
  if (
    status.state === 'not-configured' ||
    status.state === 'unavailable' ||
    status.state === 'conflict'
  ) {
    return status;
  }
  const platform = deps.platform ?? process.platform;
  const home = deps.homedir ?? homedir();
  const report: OfficeHostReport = { apps: {} };
  let changed = false;

  const anchor = anchorOf(status);
  if (anchor) {
    const installed = await m.trust.isTrusted(anchor).catch(() => false);
    if (installed !== status.trust.installed) {
      report.trust = { installed };
      changed = true;
    }
  }
  for (const app of status.apps) {
    const reg = registrationOf(app);
    if (!app.selected || !reg) continue;
    let registered = await m.office.isOfficeAddinRegistered(reg).catch(() => false);
    if (!registered && platform === 'darwin') {
      const copy = m.office.macManifestCopyPath(reg.app, reg.manifestId, home);
      const hadCopy = await access(copy).then(
        () => true,
        () => false,
      );
      if (hadCopy) {
        registered = await m.office
          .registerOfficeAddin(reg)
          .then(() => m.office.isOfficeAddinRegistered(reg))
          .catch(() => false);
      }
    }
    if (registered !== app.registered) {
      report.apps![reg.app] = { registered };
      changed = true;
    }
  }
  return changed ? client.reportOfficeHost(report) : status;
}

export async function clearOfficeCache(deps: OfficeIntegrationDeps = {}): Promise<void> {
  await mods(deps).office.clearOfficeAddinCache();
}

// ── LibreOffice ───────────────────────────────────────────────────────────

export async function enableLibreOffice(
  client: OfficeIntegrationClient,
  deps: OfficeIntegrationDeps = {},
): Promise<LibreOfficeSetupStatusResponse> {
  const m = mods(deps);
  const status = await client.configureLibreOffice();
  if (!status.unopkgPath || !status.oxtPath) {
    return client.reportLibreOfficeHost({
      installed: false,
      error: status.unopkgPath
        ? 'This Gezel build does not include the extension.'
        : 'LibreOffice was not found.',
    });
  }
  try {
    await m.lo.installLibreOfficeExtension({
      unopkgPath: status.unopkgPath,
      oxtPath: status.oxtPath,
    });
    const listed = await m.lo.isLibreOfficeExtensionInstalled({ unopkgPath: status.unopkgPath });
    // `unopkg add` succeeded; a list that cannot answer does not overrule it.
    return client.reportLibreOfficeHost({ installed: listed !== false });
  } catch (err) {
    return client.reportLibreOfficeHost({ installed: false, error: message(err) });
  }
}

export async function disableLibreOffice(
  client: OfficeIntegrationClient,
  deps: OfficeIntegrationDeps = {},
): Promise<LibreOfficeSetupStatusResponse> {
  const m = mods(deps);
  const status = await client.getLibreOfficeSetupStatus();
  if (status.unopkgPath) {
    await m.lo.uninstallLibreOfficeExtension({ unopkgPath: status.unopkgPath });
  }
  return client.removeLibreOfficeSetup();
}

/**
 * Boot: report whether the extension is still installed, and install a
 * newer bundled `.oxt` when LibreOffice is closed. Neither prompts.
 */
export async function verifyLibreOffice(
  client: OfficeIntegrationClient,
  deps: OfficeIntegrationDeps = {},
): Promise<LibreOfficeSetupStatusResponse> {
  const m = mods(deps);
  const status = await client.getLibreOfficeSetupStatus();
  if (status.state !== 'configured' && status.state !== 'update-needed') return status;
  if (!status.unopkgPath) return status;
  const listed = await m.lo.isLibreOfficeExtensionInstalled({ unopkgPath: status.unopkgPath });
  const newerAvailable = status.installed === true && status.reasons.some((r) => /newer/i.test(r));
  if (newerAvailable && status.oxtPath) {
    try {
      await m.lo.installLibreOfficeExtension({
        unopkgPath: status.unopkgPath,
        oxtPath: status.oxtPath,
      });
      return client.reportLibreOfficeHost({ installed: true });
    } catch {
      return status; // LibreOffice is open; try again next launch.
    }
  }
  if (listed !== null && listed !== status.installed) {
    return client.reportLibreOfficeHost({ installed: listed });
  }
  return status;
}
