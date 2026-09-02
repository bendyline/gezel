import { describe, expect, it } from 'vitest';
import {
  childProcessNotice,
  engineBackendNotice,
  railSystemNotices,
  serviceNotice,
  updateNotice,
} from './system-notices.js';

describe('serviceNotice', () => {
  it('says nothing when the launch was healthy', () => {
    expect(serviceNotice({ reason: null })).toBeNull();
  });

  // The old copy promised the background work would resume on its own. It
  // does not: the app fell back to hosting the service inside its own window.
  it('never promises that background work comes back by itself', () => {
    const notice = serviceNotice({
      reason: 'System service was unavailable: SCM stopped',
      code: 'system-service-unhealthy',
      platform: 'darwin',
    });

    expect(notice?.id).toBe('service-unavailable');
    expect(notice?.title).not.toMatch(/temporarily|paused/i);
    expect(notice?.body).toMatch(/will not start again by itself/);
    expect(notice?.body).toMatch(/Run the Gezel PKG again/);
    expect(notice?.technical).toBe('System service was unavailable: SCM stopped');
  });

  // Product data and scheduled work are deliberately per-user. An installer
  // failure only removes cross-account model/resource sharing.
  it('distinguishes a missing machine engine from a dead product service', () => {
    const notice = serviceNotice({
      reason: 'The Gezel installer could not register the shared machine model engine',
      code: 'machine-service-not-installed',
      platform: 'win32',
    });

    expect(notice?.id).toBe('machine-service-not-installed');
    expect(notice?.title).not.toMatch(/off|unavailable|failed/i);
    expect(notice?.body).toMatch(/scheduled tasks.*stay in this account/i);
    expect(notice?.body).toMatch(/not being shared/i);
    expect(notice?.body).toMatch(/Run the Gezel installer again/);
    expect(notice?.technical).toMatch(/could not register/);
  });

  it('keeps a temporarily unavailable machine engine separate from background-work failure', () => {
    const notice = serviceNotice({
      reason: 'engine probe returned HTTP 503',
      code: 'machine-engine-unavailable',
      platform: 'darwin',
    });

    expect(notice?.id).toBe('machine-engine-unavailable');
    expect(notice?.body).toMatch(/scheduled work.*as usual/i);
    expect(notice?.body).toMatch(/retry.*automatically/i);
    expect(notice?.body).not.toMatch(/Background work is off/i);
  });

  it('explains the non-destructive compatibility path for established machine data', () => {
    const notice = serviceNotice({
      reason: 'established machine home preserved',
      code: 'legacy-machine-data',
      platform: 'darwin',
    });

    expect(notice?.id).toBe('legacy-machine-data');
    expect(notice?.body).toMatch(/nothing is moved or hidden/i);
    expect(notice?.body).toMatch(/per-user migration/i);
    expect(notice?.reportable).toBe(false);
  });

  // A skewed machine service is healthy and still holding the user's data.
  // "Background work is off" would be wrong about both, and its advice
  // (reopen Gezel) does not fix a version mismatch.
  it('tells the user to reinstall when the app and service versions differ', () => {
    const notice = serviceNotice({
      reason: 'service 1.26210.19, app 1.26211.23',
      code: 'system-service-version-mismatch',
      platform: 'linux',
    });

    expect(notice?.id).toBe('service-version-mismatch');
    expect(notice?.body).toMatch(/Reinstall the Gezel \.deb or \.rpm package/);
    expect(notice?.body).not.toMatch(/Background work is off/);
  });

  // A store build running its own service is the design working, not a
  // failure. The "Background work is off" copy would be wrong about both:
  // nothing is off, and its advice (reinstall) does not apply to an app the
  // store manages.
  it('explains a store build running its own service without alarming', () => {
    for (const code of ['store-service-unhealthy', 'store-service-incompatible'] as const) {
      const notice = serviceNotice({ reason: 'generation 2 vs 1', code, platform: 'darwin' });
      expect(notice?.id).toBe('store-service-separate');
      expect(notice?.railLabel).toBe('Running its own service');
      expect(notice?.reportable).toBe(false);
      expect(notice?.body).not.toMatch(/Background work is off/);
      expect(notice?.body).not.toMatch(/[Rr]einstall/);
      expect(notice?.technical).toBe('generation 2 vs 1');
    }
  });

  it('tells an incompatible store build what would fix it', () => {
    const notice = serviceNotice({
      reason: 'generation mismatch',
      code: 'store-service-incompatible',
      platform: 'win32',
    });
    expect(notice?.body).toMatch(/different version/i);
    expect(notice?.body).toMatch(/[Uu]pdating both/);
  });

  it('names the right installer per platform', () => {
    const base = { reason: 'down', code: 'system-service-unhealthy' };
    expect(serviceNotice({ ...base, platform: 'win32' })?.body).toMatch(
      /Run the Gezel installer again/,
    );
    expect(serviceNotice({ ...base, platform: 'darwin' })?.body).toMatch(/Run the Gezel PKG again/);
    // Outside Electron there is no platform — still say something true.
    expect(serviceNotice(base)?.body).toMatch(/Run the Gezel installer again/);
  });
});

describe('updateNotice', () => {
  it('maps checking, current, and download progress into calm rail status', () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice({ kind: 'checking' })?.railLabel).toBe('Checking for updates…');
    expect(updateNotice({ kind: 'up-to-date', version: '1.2.3' })?.tone).toBe('success');
    const downloading = updateNotice({
      kind: 'downloading',
      version: '1.2.3',
      percent: 42,
      transferred: 12 * 1024 * 1024,
      total: 30 * 1024 * 1024,
    });
    expect(downloading?.railLabel).toBe('Downloading update · 42%');
    expect(downloading?.body).toContain('12 MB of 30 MB');
  });

  it('tells Windows users that a ready update installs on a complete quit', () => {
    const notice = updateNotice({ kind: 'ready', version: '1.2.3' }, 'win32');
    expect(notice?.id).toBe('update-ready');
    expect(notice?.railLabel).toBe('Update ready — quit to install');
    expect(notice?.body).toMatch(/quit Gezel completely/i);
    expect(notice?.body).toMatch(/system tray/i);
  });

  it('keeps the macOS installer handoff distinct from install-on-quit', () => {
    const notice = updateNotice({ kind: 'ready', version: '1.2.3' }, 'darwin');
    expect(notice?.railLabel).toBe('Update ready to install');
    expect(notice?.body).toMatch(/choose Open installer/i);
    expect(notice?.body).not.toMatch(/automatically after you quit/i);
  });

  it('directs Linux users to a manual provenance-verified install', () => {
    const notice = updateNotice({ kind: 'available', version: '1.2.3' }, 'linux');
    expect(notice?.id).toBe('update-available');
    expect(notice?.railLabel).toBe('Update available — install manually');
    expect(notice?.body).toMatch(/notification-only/i);
    expect(notice?.body).toMatch(/SLSA build provenance/i);
    expect(notice?.link).toEqual({
      href: 'https://github.com/bendyline/gezel/releases/tag/v1.2.3',
      label: 'Open release and verification steps',
    });
  });

  // The reported bug: a failed *check* — what an offline launch and a repo
  // with no published release both look like — was shown as "Gezel could not
  // install an update", front and center on Home.
  it('keeps a failed check out of the rail and never calls it an install failure', () => {
    const notice = updateNotice({
      kind: 'error',
      stage: 'check',
      message: 'net::ERR_INTERNET_DISCONNECTED',
    });

    expect(notice?.id).toBe('update-check-failed');
    expect(notice?.railLabel).toBeNull();
    expect(notice?.title).toMatch(/could not check for updates/i);
    expect(notice?.title).not.toMatch(/install/i);
  });

  it('reads a stage-less error from an older shell as the quieter check failure', () => {
    expect(updateNotice({ kind: 'error', message: 'boom' })?.id).toBe('update-check-failed');
  });

  it('offers a manual download when a verified update could not be installed', () => {
    const notice = updateNotice({
      kind: 'error',
      stage: 'install',
      version: '1.26212.4',
      message: 'Gatekeeper rejected the package',
    });

    expect(notice?.id).toBe('update-install-failed');
    expect(notice?.railLabel).toBe('Update needs attention');
    expect(notice?.link?.href).toBe('https://github.com/bendyline/gezel/releases/tag/v1.26212.4');
  });

  it('surfaces a failed download separately from check and install failures', () => {
    const notice = updateNotice({
      kind: 'error',
      stage: 'download',
      version: '1.26212.4',
      message: 'disk full',
    });
    expect(notice?.id).toBe('update-download-failed');
    expect(notice?.railLabel).toMatch(/download needs attention/i);
    expect(notice?.technical).toBe('disk full');
  });

  it('falls back to the releases list, never repository latest, with no known version', () => {
    const notice = updateNotice({ kind: 'error', stage: 'install', message: 'staging failed' });
    expect(notice?.link?.href).toBe('https://github.com/bendyline/gezel/releases');
  });
});

describe('railSystemNotices', () => {
  it('is empty on a healthy install', () => {
    expect(railSystemNotices({ reason: null, update: null })).toEqual([]);
  });

  it('carries the service notice first and drops the rail-less check failure', () => {
    const notices = railSystemNotices({
      reason: 'down',
      code: 'system-service-unhealthy',
      platform: 'win32',
      update: { kind: 'error', stage: 'check', message: 'offline' },
    });

    expect(notices.map((n) => n.id)).toEqual(['service-unavailable']);
  });
});

describe('childProcessNotice', () => {
  it('is absent unless the daemon actually reported denied', () => {
    expect(childProcessNotice({})).toBeNull();
    expect(childProcessNotice({ denied: false, platform: 'win32' })).toBeNull();
  });

  it('names the scattered symptoms so they read as one cause', () => {
    const notice = childProcessNotice({ denied: true, platform: 'win32' });
    expect(notice?.id).toBe('child-process-denied');
    expect(notice?.railLabel).toBe('Service cannot run programs');
    for (const symptom of ['local models', 'GPU', 'scripts']) {
      expect(notice?.body).toContain(symptom);
    }
    // Reassurance first: nothing the user made is at risk here.
    expect(notice?.body).toContain('safe');
    expect(notice?.reportable).toBe(true);
  });

  // The fix a person can perform goes in the body; the fix an administrator
  // would rather run goes behind the disclosure. Neither may go missing.
  it('offers the installer in the copy and the sc.exe repair in the technical detail', () => {
    const notice = childProcessNotice({ denied: true, platform: 'win32' });
    expect(notice?.body).toContain('Run the Gezel installer again');
    expect(notice?.technical).toContain('sc.exe sidtype GezelService unrestricted');
  });

  // A daemon that cannot spawn is a more specific and more severe diagnosis
  // than "the service is degraded", so it must not sort below it.
  it('outranks the service notice in the rail', () => {
    const notices = railSystemNotices({
      reason: 'down',
      platform: 'win32',
      update: null,
      childProcessDenied: true,
    });
    expect(notices.map((n) => n.id)).toEqual(['child-process-denied', 'service-unavailable']);
  });
});

describe('engineBackendNotice', () => {
  it('names the demoted backend and what is running instead', () => {
    const notice = engineBackendNotice({ quarantined: ['cuda'], running: 'vulkan' });
    expect(notice?.id).toBe('engine-backend-quarantined');
    expect(notice?.title).toContain('NVIDIA GPU (CUDA)');
    expect(notice?.body).toContain('GPU (Vulkan)');
    // Must not read as broken — the app works, it is just slower.
    expect(notice?.body).toContain('Everything still works');
    expect(notice?.railLabel).toBe('Running on GPU (Vulkan)');
  });

  it('is absent when nothing is quarantined', () => {
    expect(engineBackendNotice({})).toBeNull();
    expect(engineBackendNotice({ quarantined: [], running: 'cuda' })).toBeNull();
  });

  it('reaches the rail alongside the other install-health notices', () => {
    const notices = railSystemNotices({
      update: null,
      quarantinedBackends: ['cuda'],
      runningBackend: 'vulkan',
    });
    expect(notices.map((n) => n.id)).toContain('engine-backend-quarantined');
  });
});

describe('which notices are worth a bug report', () => {
  it('marks every genuine install failure reportable', () => {
    const reason = 'spawn failed';
    for (const code of ['machine-service-not-installed', 'system-service-version-mismatch', null]) {
      expect(serviceNotice({ reason, code })?.reportable).toBe(true);
    }
    expect(updateNotice({ kind: 'error', stage: 'install', message: 'boom' })?.reportable).toBe(
      true,
    );
    expect(engineBackendNotice({ quarantined: ['cuda'], running: 'cpu' })?.reportable).toBe(true);
  });

  it('does not solicit a bug report for being offline', () => {
    // A failed update *check* is what an offline launch looks like. Nothing
    // is wrong with the install, so an issue for it is pure noise.
    expect(updateNotice({ kind: 'error', stage: 'check', message: 'ENOTFOUND' })?.reportable).toBe(
      undefined,
    );
  });
});
