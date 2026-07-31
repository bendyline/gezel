import { describe, expect, it } from 'vitest';
import { railSystemNotices, serviceNotice, updateNotice } from './system-notices.js';

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

  // The per-user daemon is a supported mode, so nothing is broken and the
  // "Background work is off" copy would be wrong: work does run, just not
  // once Gezel closes. Only the installer registers the machine service, so
  // the advice has to be "rerun the installer", not "reopen Gezel".
  it('distinguishes a per-user fallback from a dead service', () => {
    const notice = serviceNotice({
      reason: 'The Gezel installer could not register the machine-wide background service',
      code: 'machine-service-not-installed',
      platform: 'win32',
    });

    expect(notice?.id).toBe('machine-service-not-installed');
    expect(notice?.title).not.toMatch(/off|unavailable|failed/i);
    expect(notice?.body).not.toMatch(/will not start again by itself/);
    expect(notice?.body).toMatch(/only runs while Gezel is open/);
    expect(notice?.body).toMatch(/Run the Gezel installer again/);
    expect(notice?.technical).toMatch(/could not register/);
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
  it('says nothing about a healthy or in-flight update', () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice({ kind: 'downloading', version: '1.2.3' })).toBeNull();
    expect(updateNotice({ kind: 'ready', version: '1.2.3' })).toBeNull();
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
