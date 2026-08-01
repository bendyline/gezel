import type { UpdateState } from './api.js';
import { RELEASES_URL, releaseUrl } from './github-urls.js';

export { releaseUrl };

/**
 * Install-health notices: the background service, and the app updater.
 *
 * These used to be full-width banners across the top of Home. Neither is
 * urgent and neither is fixable in the moment — a failed update *check* is
 * the ordinary offline case, and a background service that did not start
 * needs the installer. Both now sit as one quiet line in the navigation rail
 * under Settings, and explain themselves fully in Settings → About.
 *
 * A notice with `railLabel: null` never reaches the rail at all; it is
 * findable in Settings and nowhere else.
 */

export type SystemNoticeId =
  | 'machine-service-not-installed'
  | 'service-version-mismatch'
  | 'service-unavailable'
  | 'update-install-failed'
  | 'update-check-failed'
  | 'engine-backend-quarantined';

export interface SystemNotice {
  id: SystemNoticeId;
  /** Short rail label, or `null` to keep the notice out of the rail. */
  railLabel: string | null;
  title: string;
  body: string;
  /** Raw diagnostic text, kept behind a disclosure. */
  technical?: string;
  link?: { href: string; label: string };
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
      railLabel: 'Background service is per-user',
      title: 'Gezel is running its per-user background service.',
      // Deliberately not the "Background work is off" copy below. That one is
      // for the embedded fallback, where the service dies with the window.
      // Here a real daemon is running and background work does happen — until
      // Gezel is closed. Saying it is off would be its own inaccuracy.
      body: `Everything works and all of your gezellen, projects, chats, and files are here. The difference is that background work — scheduled tasks and night shift — only runs while Gezel is open, and first launch after an update takes longer. The machine-wide service is installed by the installer, so this is the one thing Gezel cannot fix from inside. ${reinstallHint(platform)}`,
      technical: reason,
      reportable: true,
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

/**
 * Update failures. A failed check is quiet by design — it is what an offline
 * launch looks like, and what a build with no published release yet looks
 * like, so it never reaches the rail.
 */
export function updateNotice(state: UpdateState | null): SystemNotice | null {
  if (!state || state.kind !== 'error') return null;

  if (state.stage === 'install') {
    return {
      id: 'update-install-failed',
      railLabel: 'Update needs attention',
      title: 'Gezel could not install the update.',
      body: 'You can keep working. Download the latest version and run the installer to update manually.',
      technical: state.message,
      reportable: true,
      link: { href: releaseUrl(state.version), label: 'Get the latest release' },
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

/** Every notice that belongs in the navigation rail, most severe first. */
export function railSystemNotices(input: {
  reason?: string | null;
  code?: string | null;
  platform?: string;
  update: UpdateState | null;
  quarantinedBackends?: readonly string[];
  runningBackend?: string;
}): SystemNotice[] {
  return [
    serviceNotice(input),
    engineBackendNotice({
      ...(input.quarantinedBackends ? { quarantined: input.quarantinedBackends } : {}),
      ...(input.runningBackend ? { running: input.runningBackend } : {}),
    }),
    updateNotice(input.update),
  ].filter((n): n is SystemNotice => n !== null && n.railLabel !== null);
}
