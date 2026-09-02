import type { UpdateState } from './api.js';
import { RELEASES_URL, releaseUrl } from './github-urls.js';

export { releaseUrl };

/**
 * Install-health notices plus the whole-app updater lifecycle.
 *
 * These used to be full-width banners across the top of Home. Neither is
 * urgent and neither is fixable in the moment — a failed update *check* is
 * the ordinary offline case, and a background service that did not start
 * needs the installer. The same quiet navigation-rail locus also carries live
 * check/download/ready progress so a large background update never disappears.
 *
 * A notice with `railLabel: null` never reaches the rail at all; it is
 * findable in Settings and nowhere else.
 */

export type SystemNoticeId =
  | 'machine-service-not-installed'
  | 'machine-service-home-fresh'
  | 'machine-engine-unavailable'
  | 'legacy-machine-data'
  | 'service-version-mismatch'
  | 'service-unavailable'
  | 'store-service-separate'
  | 'update-checking'
  | 'update-up-to-date'
  | 'update-available'
  | 'update-downloading'
  | 'update-ready'
  | 'update-download-failed'
  | 'update-install-failed'
  | 'update-check-failed'
  | 'engine-backend-quarantined'
  | 'child-process-denied';

export interface SystemNotice {
  id: SystemNoticeId;
  /** Short rail label, or `null` to keep the notice out of the rail. */
  railLabel: string | null;
  title: string;
  body: string;
  /** Raw diagnostic text, kept behind a disclosure. */
  technical?: string;
  link?: { href: string; label: string };
  /** Visual temperature of the rail dot; failures default to warning. */
  tone?: 'progress' | 'success' | 'warning';
  /**
   * Whether this condition is worth a bug report. A failed update *check* is
   * what being offline looks like — nothing is wrong with the install — so
   * soliciting an issue for it is pure maintainer noise.
   *
   * Deliberately decided here rather than at the render site, so the "which
   * conditions are reportable" policy sits with the rest of the notice
   * policy and the two can never drift.
   */
  reportable?: boolean;
}

/**
 * How to reinstall, per platform. "Rerun the installer" means a different
 * artifact on each OS, and it is the only fix for both service notices.
 */
const REINSTALL_HINT: Record<string, string> = {
  darwin: 'Run the Gezel PKG again and approve Installer’s administrator prompt.',
  win32: 'Run the Gezel installer again and approve the Windows administrator prompt.',
  linux: 'Reinstall the Gezel .deb or .rpm package.',
};

function reinstallHint(platform?: string): string {
  return (platform && REINSTALL_HINT[platform]) ?? 'Run the Gezel installer again.';
}

/**
 * The supervisor's degraded-launch report, as a notice. `code` distinguishes
 * a healthy machine service running a different release (the app is the odd
 * one out; nothing is paused) from a service that never came up.
 */
export function serviceNotice(input: {
  reason?: string | null;
  code?: string | null;
  platform?: string;
}): SystemNotice | null {
  const { reason, code, platform } = input;
  if (!reason) return null;

  if (code === 'machine-service-not-installed') {
    return {
      id: 'machine-service-not-installed',
      railLabel: 'Model sharing is off',
      title: 'Gezel is using this account’s model engine.',
      body: `Everything works and all of your gezellen, projects, chats, files, scheduled tasks, and night shift stay in this account. Local model downloads, memory use, and GPU work are not being shared with other Gezel users on this machine. The shared engine is installed for the whole machine, so Gezel cannot repair it from inside the app. ${reinstallHint(platform)}`,
      technical: reason,
      reportable: true,
    };
  }

  if (code === 'machine-engine-unavailable') {
    return {
      id: 'machine-engine-unavailable',
      railLabel: 'Model sharing is off',
      title: 'The shared model engine is unavailable.',
      body: `Gezel is keeping your projects, chats, tools, scheduled work, and credentials in this account as usual. Local model work is running here instead, so downloads, memory use, and GPU queues are not shared with other Gezel users on this machine. Gezel will retry the shared engine automatically; if it remains unavailable, ${reinstallHint(platform).replace(/^./, (letter) => letter.toLowerCase())}`,
      technical: reason,
      reportable: true,
    };
  }

  if (code === 'legacy-machine-data') {
    return {
      id: 'legacy-machine-data',
      railLabel: 'Data migration needed',
      title: 'Gezel preserved your machine-wide projects.',
      body: 'This installation contains projects made by an older machine-wide Gezel service. They remain available in compatibility mode, so nothing is moved or hidden during the upgrade. User-owned folders outside that service home still have the older access limitation. Keep this installation and its machine data in place until Gezel offers an explicit per-user migration.',
      technical: reason,
      reportable: false,
    };
  }

  if (code === 'machine-service-home-fresh') {
    return {
      id: 'machine-service-home-fresh',
      railLabel: 'Using your per-user data',
      title: 'Gezel is using your per-user data.',
      // A deliberate choice, not a failure: the machine-wide service is
      // healthy but has never held any data, while this account's home has
      // the user's real gezellen and projects. Connecting to the empty one
      // would look like everything vanished.
      body: 'The machine-wide background service is running, but it has never held any data — while this account already has gezellen, projects, and chats. Gezel connected to your existing data and will keep doing so. Everything works normally; the machine-wide service simply sits idle. This choice is saved, and you can revisit it under Settings.',
      technical: reason,
      // Working as intended — a bug report would only say "my data is where
      // I left it".
      reportable: false,
    };
  }

  if (code === 'system-service-version-mismatch') {
    return {
      id: 'service-version-mismatch',
      railLabel: 'Service version differs',
      title: 'Gezel updated, but its background service did not.',
      body: `Everything still works and none of your gezellen, projects, or chats are affected — but the app and the service are on different versions, so newer features may misbehave until they match. The service is installed for the whole machine, so only the installer can replace it. ${reinstallHint(platform)}`,
      technical: reason,
      reportable: true,
    };
  }

  // Both store codes describe the SAME outcome — this app is running its own
  // service instead of sharing the installed one — so they share copy shaped
  // around that, not around the failure. The distinction the user can act on
  // is only in `technical`.
  //
  // Deliberately NOT the "Background work is off" notice below. That one warns
  // that scheduled work stops and nothing resumes on its own, which is true of
  // an embedded fallback in a direct install. Here the app's own service is a
  // complete, working service; the only thing lost is sharing one daemon (and
  // its already-loaded models) with the other installation.
  if (code === 'store-service-unhealthy' || code === 'store-service-incompatible') {
    return {
      id: 'store-service-separate',
      railLabel: 'Running its own service',
      title: 'Gezel is running its own background service.',
      body:
        code === 'store-service-incompatible'
          ? 'Another copy of Gezel is installed on this computer, but it is a different version than this app can share a service with. This app started its own instead, so everything works normally — the two simply keep separate services, and a model loaded in one is not reused by the other. Updating both copies to current versions lets them share again.'
          : 'Another copy of Gezel is installed on this computer, but its background service was not responding, so this app started its own. Everything works normally; the two simply keep separate services for now. They will try to share again the next time you open Gezel.',
      technical: reason,
      // Nothing is broken and nothing to report — this is the design working.
      reportable: false,
    };
  }

  return {
    id: 'service-unavailable',
    railLabel: 'Background work is off',
    // Deliberately not "temporarily paused": nothing here resumes on its own.
    // The app fell back to running the service inside its own window, so it
    // dies with the window and cannot host scheduled work at all.
    title: 'Background work is off.',
    body: `Gezel itself works normally and all of your gezellen, projects, chats, and files are here. Autostart, scheduled work, and night shift stay off until the background service runs again, and it will not start again by itself. Reopening Gezel retries it once; if it stays off, reinstall Gezel. ${reinstallHint(platform)}`,
    technical: reason,
    reportable: true,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function downloadDetail(state: Extract<UpdateState, { kind: 'downloading' }>): string {
  const parts: string[] = [];
  if (state.transferred !== undefined && state.total !== undefined) {
    parts.push(`${formatBytes(state.transferred)} of ${formatBytes(state.total)}`);
  }
  if (state.bytesPerSecond !== undefined) {
    parts.push(`${formatBytes(state.bytesPerSecond)}/s`);
  }
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/** One source of truth for update copy in the rail and Settings → About. */
export function updateNotice(state: UpdateState | null, platform?: string): SystemNotice | null {
  if (!state) return null;

  if (state.kind === 'checking') {
    return {
      id: 'update-checking',
      railLabel: 'Checking for updates…',
      title: 'Gezel is checking for updates.',
      body: 'This usually takes only a moment.',
      tone: 'progress',
    };
  }

  if (state.kind === 'up-to-date') {
    return {
      id: 'update-up-to-date',
      railLabel: 'Gezel is up to date',
      title: `Gezel ${state.version} is up to date.`,
      body: 'No newer public desktop release is available.',
      tone: 'success',
    };
  }

  if (state.kind === 'available') {
    return {
      id: 'update-available',
      railLabel: 'Update available — install manually',
      title: `Gezel ${state.version} is available.`,
      body: 'Linux updates are notification-only because the .deb and .rpm packages are not yet signed through a distribution repository. Download the package from GitHub and verify its SLSA build provenance before installing it manually.',
      link: { href: releaseUrl(state.version), label: 'Open release and verification steps' },
      tone: 'success',
    };
  }

  if (state.kind === 'downloading') {
    const percent = state.percent === undefined ? '' : ` · ${state.percent}%`;
    return {
      id: 'update-downloading',
      railLabel: `Downloading update${percent}`,
      title: `Downloading Gezel ${state.version}.`,
      body: `You can keep working while the update downloads${downloadDetail(state)}.`,
      tone: 'progress',
    };
  }

  if (state.kind === 'ready') {
    const automatic = platform === 'win32';
    return {
      id: 'update-ready',
      railLabel: automatic ? 'Update ready — quit to install' : 'Update ready to install',
      title: `Gezel ${state.version} is ready to install.`,
      body: automatic
        ? 'It will install automatically after you quit Gezel completely. Closing the window may leave Gezel running in the system tray.'
        : 'Choose Open installer in Settings or on Home to launch the verified macOS installer.',
      tone: 'success',
    };
  }

  if (state.stage === 'download') {
    return {
      id: 'update-download-failed',
      railLabel: 'Update download needs attention',
      title: 'Gezel could not download the update.',
      body: 'You can keep working. Gezel will try again next time it starts, or you can download the installer yourself.',
      technical: state.message,
      link: { href: releaseUrl(state.version), label: 'Get the latest release' },
      tone: 'warning',
    };
  }

  if (state.stage === 'install') {
    return {
      id: 'update-install-failed',
      railLabel: 'Update needs attention',
      title: 'Gezel could not install the update.',
      body: 'You can keep working. Download the latest version and run the installer to update manually.',
      technical: state.message,
      reportable: true,
      link: { href: releaseUrl(state.version), label: 'Get the latest release' },
      tone: 'warning',
    };
  }

  return {
    id: 'update-check-failed',
    railLabel: null,
    title: 'Gezel could not check for updates.',
    body:
      'Nothing is wrong with this install. Gezel could not reach the release listing — normal when ' +
      'you are offline or behind a restrictive network, and also what it looks like when no public ' +
      'release has been published yet. Gezel will try again the next time it starts.',
    technical: state.message,
    link: { href: RELEASES_URL, label: 'Check releases yourself' },
    tone: 'warning',
  };
}

const BACKEND_LABEL: Record<string, string> = {
  cuda: 'NVIDIA GPU (CUDA)',
  vulkan: 'GPU (Vulkan)',
  metal: 'GPU (Metal)',
  cpu: 'CPU',
};

function backendLabel(backend?: string): string {
  return (backend && BACKEND_LABEL[backend]) ?? backend ?? 'another backend';
}

/**
 * A GPU backend that crashed on this machine and was routed around.
 *
 * This one earns a rail label where the other install-health notices are
 * borderline, because it is silent by construction: the app keeps working,
 * just on a slower engine, and nothing else on screen says why. A user can
 * spend a long time assuming their GPU is being used.
 *
 * Unlike the service notices, this IS actionable — the fallback is a real
 * downgrade and the cause is usually a driver or a build that a later
 * release fixes — so the copy names the demoted backend rather than
 * speaking generally.
 */
export function engineBackendNotice(input: {
  quarantined?: readonly string[];
  running?: string;
}): SystemNotice | null {
  const demoted = input.quarantined?.[0];
  if (!demoted) return null;
  return {
    id: 'engine-backend-quarantined',
    railLabel: `Running on ${backendLabel(input.running)}`,
    title: `Gezel switched off ${backendLabel(demoted)} on this machine.`,
    body: [
      `The ${backendLabel(demoted)} engine crashed every time it started here, so Gezel is using`,
      `${backendLabel(input.running)} instead. Everything still works — local models are just`,
      'slower than this machine is capable of. Gezel retries automatically once a Gezel update',
      'ships a new engine build, and updating your GPU driver is worth trying in the meantime.',
    ].join(' '),
    technical: `quarantined backends: ${input.quarantined?.join(', ')}`,
    // The most report-worthy of the lot: a backend that crashes on every
    // start is a build or driver bug, and the machine profile in the report
    // is exactly what triaging it needs.
    reportable: true,
  };
}

/**
 * The background service is running but cannot start any program of its own.
 *
 * The most severe notice here, and the only one where the honest summary is
 * "most of Gezel does not work." Local models, GPU detection, gezel tools,
 * scripts, and installs are all separate programs the service starts, so one
 * cause produces a scatter of unrelated-looking failures. Without this the
 * user reads them as five broken features.
 *
 * The copy leads with reinstalling because that is the fix a person can
 * actually perform — the Windows installer that produced this state has been
 * corrected, so running the current one repairs it. The `sc.exe` command is
 * real and faster, but it needs an elevated prompt and a service name, so it
 * belongs behind the technical disclosure where an administrator will look
 * and nobody else has to.
 */
export function childProcessNotice(input: {
  denied?: boolean;
  platform?: string;
}): SystemNotice | null {
  if (!input.denied) return null;
  return {
    id: 'child-process-denied',
    railLabel: 'Service cannot run programs',
    title: 'Gezel’s background service is not allowed to start programs.',
    body: `Your gezellen, projects, chats, and files are all safe and nothing has been lost. But the background service cannot start the programs it needs, so local models will not answer, your GPU is not detected, and gezel tools, scripts, and installs will fail. This comes from how the service was registered on this PC, which Gezel cannot change from inside. ${reinstallHint(input.platform)}`,
    technical:
      'Child-process creation is denied (spawn EPERM). The GezelService token is write-restricted; ' +
      'from an elevated prompt: sc.exe sidtype GezelService unrestricted, then restart the service.',
    reportable: true,
  };
}

/** Every notice that belongs in the navigation rail, most severe first. */
export function railSystemNotices(input: {
  reason?: string | null;
  code?: string | null;
  platform?: string;
  update: UpdateState | null;
  quarantinedBackends?: readonly string[];
  runningBackend?: string;
  childProcessDenied?: boolean;
}): SystemNotice[] {
  return [
    // Ahead of the service notices on purpose: those describe a service that
    // is degraded or absent, this one a service that is present and unable to
    // do the work. It is the more specific and the more severe diagnosis.
    childProcessNotice({
      ...(input.childProcessDenied ? { denied: input.childProcessDenied } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
    }),
    serviceNotice(input),
    engineBackendNotice({
      ...(input.quarantinedBackends ? { quarantined: input.quarantinedBackends } : {}),
      ...(input.runningBackend ? { running: input.runningBackend } : {}),
    }),
    updateNotice(input.update, input.platform),
  ].filter((n): n is SystemNotice => n !== null && n.railLabel !== null);
}
