import type { LlamaCppBackendHealthResponse } from '@bendyline/gezel';
import type { UpdateState } from './api.js';
import { RELEASES_URL, releaseUrl } from './github-urls.js';
import { localEngineSettingsLabel } from './views/local-engine-label.js';

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
  | 'shared-service-version-mismatch'
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
  | 'engine-gpu-unused'
  | 'engine-runtime-missing'
  | 'engine-out-of-memory'
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
  /**
   * The Settings section the rail opens, when the notice lives with its
   * action there rather than in About.
   */
  settingsSection?: string;
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

const GEZEL_DOWNLOAD_URL = 'https://gezel.com/';

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

  // The installed shared service is a different version than this app, so
  // the app runs its own instead of stopping to ask. The app is not broken;
  // the only fix is an installer whose shared service matches, which is why
  // this carries a download link rather than a report link.
  if (code === 'machine-engine-incompatible' || code === 'store-service-incompatible') {
    return {
      id: 'shared-service-version-mismatch',
      railLabel: 'Shared services are off',
      title: 'Gezel is running without shared services because of a version mismatch.',
      body: 'The shared Gezel service installed on this computer is a different version than this app, so the two cannot work together. Everything still works — this app runs its own service instead — but it does not share models or memory with the installed service, so Gezel may not coordinate memory use as effectively. Download the full version of Gezel, which includes a matching shared service, to turn shared services back on.',
      technical: reason,
      link: { href: GEZEL_DOWNLOAD_URL, label: 'Download the full version' },
      reportable: false,
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

  // Deliberately NOT the "Background work is off" notice below. That one warns
  // that scheduled work stops and nothing resumes on its own, which is true of
  // an embedded fallback in a direct install. Here the app's own service is a
  // complete, working service; the only thing lost is sharing one daemon (and
  // its already-loaded models) with the other installation.
  if (code === 'store-service-unhealthy') {
    return {
      id: 'store-service-separate',
      railLabel: 'Running its own service',
      title: 'Gezel is running its own background service.',
      body: 'Another copy of Gezel is installed on this computer, but its background service was not responding, so this app started its own. Everything works normally; the two simply keep separate services for now. They will try to share again the next time you open Gezel.',
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

/** How the notices and the engine's Settings tab name a llama.cpp backend. */
export function engineBackendLabel(backend?: string): string {
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
  platform?: string;
}): SystemNotice | null {
  const demoted = input.quarantined?.[0];
  if (!demoted) return null;
  return {
    id: 'engine-backend-quarantined',
    railLabel: `Running on ${engineBackendLabel(input.running)}`,
    title: `Gezel switched off ${engineBackendLabel(demoted)} on this machine.`,
    body: [
      `The ${engineBackendLabel(demoted)} engine crashed several times in a row while starting here,`,
      `so Gezel is using ${engineBackendLabel(input.running)} instead. Everything still works — local`,
      'models are just slower than this machine is capable of. Gezel retries automatically once a',
      'Gezel update ships a new engine build. After updating your GPU driver, you can turn it back',
      `on from Settings → ${localEngineSettingsLabel('llama-cpp', input.platform)}.`,
    ].join(' '),
    technical: `quarantined backends: ${input.quarantined?.join(', ')}`,
    // The most report-worthy of the lot: a backend that crashes on every
    // start is a build or driver bug, and the machine profile in the report
    // is exactly what triaging it needs.
    reportable: true,
    settingsSection: LLAMA_SETTINGS_SECTION,
  };
}

/** The llama.cpp engine's Settings section, where its notices and actions live. */
const LLAMA_SETTINGS_SECTION = 'llamaCpp';

/**
 * The engine is not getting the GPU this machine has, and nothing else says
 * so: it keeps answering, every token on a slower path.
 *
 * Two sources, root cause first. Discovery passed over the CUDA build because
 * the NVIDIA driver cannot run it (Linux) — a restart or a driver update fixes
 * that, and Gezel picks CUDA again by itself. Or a GPU build started without
 * its GPU: the GPU library failed to load or found nothing, which leaves the
 * engine on the processor while every label says CUDA or Vulkan.
 */
export function engineGpuNotice(input: {
  health?: LlamaCppBackendHealthResponse | null;
  platform?: string;
}): SystemNotice | null {
  const health = input.health;
  if (!health) return null;
  const blocker = health.cudaBlocker;
  const unused = health.gpuUnused;
  if (!blocker && !unused) return null;
  const tab = `Settings → ${localEngineSettingsLabel('llama-cpp', input.platform)}`;
  // A fallback build that also started without a GPU leaves the processor.
  const running = unused ? 'cpu' : health.running;
  const instead =
    running === 'cpu'
      ? 'every reply is computed on the processor, which is much slower than this machine can do'
      : `Gezel is using ${engineBackendLabel(running)} instead, which still uses a GPU but is usually slower`;
  const technical = [blocker?.detail, unused ? gpuUnusedTechnical(unused) : undefined]
    .filter(Boolean)
    .join('\n');

  if (blocker?.kind === 'restart-required') {
    return {
      id: 'engine-gpu-unused',
      railLabel: 'Restart to use your GPU',
      title: 'Restart your computer to finish the NVIDIA driver update.',
      body: `An NVIDIA driver update is installed but not loaded yet, and CUDA will not run until the computer restarts. Until then ${instead}. After the restart Gezel uses your NVIDIA GPU again by itself.`,
      technical,
      reportable: false,
      settingsSection: LLAMA_SETTINGS_SECTION,
    };
  }
  if (blocker?.kind === 'driver-too-old') {
    const needed = blocker.required ? `version ${blocker.required} or newer` : 'a newer version';
    return {
      id: 'engine-gpu-unused',
      railLabel: 'Update your NVIDIA driver',
      title: 'Your NVIDIA driver is too old for Gezel’s CUDA engine.',
      body: `The driver installed here${blocker.installed ? ` (${blocker.installed})` : ''} is older than the CUDA engine needs, so ${instead}. Update the NVIDIA driver to ${needed} and restart your computer; Gezel then uses CUDA by itself.`,
      technical,
      reportable: false,
      settingsSection: LLAMA_SETTINGS_SECTION,
    };
  }
  if (blocker?.kind === 'module-not-loaded') {
    return {
      id: 'engine-gpu-unused',
      railLabel: 'Your GPU is not in use',
      title: 'The NVIDIA driver is installed but not running.',
      body: `Linux did not load the NVIDIA driver, so ${instead}. This usually happens after a system update when the driver was not rebuilt for the new kernel, or when Secure Boot blocks it. Reinstalling the NVIDIA driver and restarting your computer usually fixes it, and Gezel then uses the GPU again by itself.`,
      technical,
      reportable: false,
      settingsSection: LLAMA_SETTINGS_SECTION,
    };
  }
  if (!unused) return null;
  const label = engineBackendLabel(unused.backend);
  const why =
    unused.reason === 'init-failed'
      ? 'CUDA would not run on the graphics card'
      : unused.reason === 'no-devices'
        ? 'the graphics driver offered no graphics card it could use'
        : 'it did not load its GPU library';
  return {
    id: 'engine-gpu-unused',
    railLabel: 'Not using your GPU',
    title: `Gezel’s ${label} engine is not using your graphics card.`,
    body: `The engine is running, but ${why}, so ${instead}. Updating or reinstalling your graphics driver usually fixes it. Until then you can choose another backend in ${tab}.`,
    technical,
    // A GPU library that never loaded can be a packaging fault of ours; a
    // driver that refused is the machine's.
    reportable: unused.reason === 'not-loaded',
    settingsSection: LLAMA_SETTINGS_SECTION,
  };
}

function gpuUnusedTechnical(unused: NonNullable<LlamaCppBackendHealthResponse['gpuUnused']>) {
  return `${unused.backend} build started without a GPU device (${unused.reason})${unused.detail ? `: ${unused.detail}` : ''}`;
}

/**
 * Windows: the on-device engines cannot start at all, because this PC lacks
 * the Microsoft Visual C++ runtime they all import. The desktop installer
 * provides it; an npm or CLI install never runs that installer. Unlike most
 * engine notices this one is the person's to fix, in a minute, so it reaches
 * the rail with Microsoft's download as its link.
 */
export function engineRuntimeNotice(input: {
  health?: LlamaCppBackendHealthResponse | null;
}): SystemNotice | null {
  const missing = input.health?.missingRuntime;
  if (!missing) return null;
  const label = missing.arch === 'arm64' ? 'ARM64' : 'x64';
  return {
    id: 'engine-runtime-missing',
    railLabel: 'Install a Windows component',
    title: 'On-device models need a free component from Microsoft.',
    body: `Gezel’s on-device chat, images and transcription use the Microsoft Visual C++ Redistributable (${label}), which is not installed on this PC, so they cannot start. Install it from Microsoft, then try again. You do not need to restart Gezel.`,
    technical: missing.detail,
    link: { href: missing.downloadUrl, label: `Download the ${label} installer` },
    reportable: false,
    settingsSection: LLAMA_SETTINGS_SECTION,
  };
}

/**
 * Linux's out-of-memory killer stopped the engine. An event rather than a
 * standing condition, so it never reaches the rail — the failed chat already
 * said so. The engine's Settings tab keeps it in view for someone who comes
 * looking for why replies keep failing.
 */
export function engineOutOfMemoryNotice(input: {
  health?: LlamaCppBackendHealthResponse | null;
}): SystemNotice | null {
  const oom = input.health?.outOfMemory;
  if (!oom) return null;
  const when = new Date(oom.at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const times = oom.count === 1 ? 'once' : `${oom.count} times`;
  const what = `${oom.whileStarting ? 'loading' : 'running'} ${oom.model ?? 'a model'}`;
  return {
    id: 'engine-out-of-memory',
    railLabel: null,
    title: 'This computer ran out of memory for the on-device engine.',
    body: `Linux stopped the engine ${times} since Gezel started, most recently on ${when} while ${what}. Closing other programs that use a lot of memory, choosing a smaller model, or shortening the context usually prevents it.`,
    technical: `out-of-memory kills: ${oom.count}; latest ${oom.at} (${oom.whileStarting ? 'while loading' : 'while serving'})`,
    reportable: false,
    settingsSection: LLAMA_SETTINGS_SECTION,
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
  backendHealth?: LlamaCppBackendHealthResponse | null;
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
    // Ahead of the backend and GPU notices: with the runtime missing, no
    // build starts, so the others describe symptoms of this one.
    engineRuntimeNotice({ health: input.backendHealth ?? null }),
    engineBackendNotice({
      ...(input.quarantinedBackends ? { quarantined: input.quarantinedBackends } : {}),
      ...(input.runningBackend ? { running: input.runningBackend } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
    }),
    engineGpuNotice({
      health: input.backendHealth ?? null,
      ...(input.platform ? { platform: input.platform } : {}),
    }),
    updateNotice(input.update, input.platform),
  ].filter((n): n is SystemNotice => n !== null && n.railLabel !== null);
}
