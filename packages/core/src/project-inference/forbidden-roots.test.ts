import { describe, expect, it } from 'vitest';
import { forbiddenRootReason } from './forbidden-roots.js';
import type { ForbiddenContext } from './types.js';

const mac: ForbiddenContext = {
  platform: 'darwin',
  homedir: '/Users/me',
  env: {},
  tmpdir: '/var/folders/xy/T',
  gezelHome: '/Users/me/.gezel',
};

const win: ForbiddenContext = {
  platform: 'win32',
  homedir: 'C:\\Users\\me',
  env: { TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' },
  tmpdir: 'C:\\Users\\me\\AppData\\Local\\Temp',
  gezelHome: 'D:\\GezelHome',
  externalFolders: { projects: 'E:\\GezelProjects' },
};

const linux: ForbiddenContext = {
  platform: 'linux',
  homedir: '/home/me',
  env: {},
  tmpdir: '/tmp',
  gezelHome: '/home/me/.gezel',
  machineSharedHome: '/var/lib/gezel',
};

describe('forbiddenRootReason — darwin', () => {
  it.each([
    ['/', 'filesystem-root'],
    ['/Users', 'home-container'],
    ['/Users/me', 'user-home'],
    ['/users/ME', 'user-home'],
    ['/Volumes', 'mount-root'],
    ['/Volumes/USB', 'mount-root'],
    ['/Users/me/.gezel/projects/x', 'gezel-home'],
    ['/Users/me/.ssh', 'hidden-home-dir'],
    ['/private/tmp/x', 'temp-dir'],
    ['/var/folders/xy/T/abc', 'temp-dir'],
    ['/Applications/Word.app', 'system-dir'],
    ['/usr/local/src', 'system-dir'],
    ['/Users/me/Library', 'per-user-app-data'],
    ['/Users/me/Library/Preferences', 'per-user-app-data'],
    ['/Users/me/Library/CloudStorage', 'cloud-root-parent'],
    ['/Users/me/Library/Mobile Documents', 'cloud-root-parent'],
  ] as const)('%s → %s', (path, reason) => {
    expect(forbiddenRootReason(path, mac)).toBe(reason);
  });

  it.each([
    '/Users/me/Documents',
    '/Users/me/work/engineeringdocs',
    '/Volumes/USB/work',
    '/Users/me/Library/CloudStorage/OneDrive-Personal',
    '/Users/me/Library/CloudStorage/Dropbox/team',
    '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Documents',
  ])('allows %s', (path) => {
    expect(forbiddenRootReason(path, mac)).toBeNull();
  });
});

describe('forbiddenRootReason — win32', () => {
  it.each([
    ['C:\\', 'filesystem-root'],
    ['D:\\', 'filesystem-root'],
    ['\\\\srv', 'network-root'],
    ['\\\\srv\\share', 'network-root'],
    ['C:\\Users', 'home-container'],
    ['c:\\users\\ME', 'user-home'],
    ['C:\\Users\\me\\AppData\\Roaming\\x', 'per-user-app-data'],
    ['C:\\Users\\me\\AppData\\Local\\Temp\\x', 'temp-dir'],
    ['C:\\Windows\\System32', 'system-dir'],
    ['D:\\Program Files\\Tool', 'system-dir'],
    ['C:\\ProgramData\\Gezel', 'system-dir'],
    ['D:\\GezelHome\\projects', 'gezel-home'],
    ['E:\\GezelProjects\\alpha', 'gezel-home'],
    ['C:\\Users\\me\\.vscode', 'hidden-home-dir'],
  ] as const)('%s → %s', (path, reason) => {
    expect(forbiddenRootReason(path, win)).toBe(reason);
  });

  it.each([
    'C:\\Users\\me\\Documents',
    'D:\\Work\\alpha',
    '\\\\srv\\share\\team',
    'C:\\Users\\me\\OneDrive - Contoso\\Documents',
  ])('allows %s', (path) => {
    expect(forbiddenRootReason(path, win)).toBeNull();
  });
});

describe('forbiddenRootReason — linux', () => {
  it.each([
    ['/', 'filesystem-root'],
    ['/home', 'home-container'],
    ['/home/me', 'user-home'],
    ['/home/me/.config/app', 'hidden-home-dir'],
    ['/etc/nginx', 'system-dir'],
    ['/opt', 'system-dir'],
    ['/srv', 'system-dir'],
    ['/mnt/usb', 'mount-root'],
    ['/media/me/USB', 'mount-root'],
    ['/run/media/me/USB', 'mount-root'],
    ['/tmp/x', 'temp-dir'],
    ['/var/tmp/x', 'temp-dir'],
    ['/var/lib/gezel/x', 'gezel-home'],
  ] as const)('%s → %s', (path, reason) => {
    expect(forbiddenRootReason(path, linux)).toBe(reason);
  });

  it.each([
    '/home/me/Documents',
    '/opt/work/alpha',
    '/srv/data/team',
    '/mnt/usb/work',
    '/run/media/me/USB/work',
  ])('allows %s', (path) => {
    expect(forbiddenRootReason(path, linux)).toBeNull();
  });

  it('is case-sensitive: /Home is not the home container', () => {
    expect(forbiddenRootReason('/Home', linux)).toBeNull();
  });

  it('exempts a Silverblue home under /var/home', () => {
    const silverblue: ForbiddenContext = { ...linux, homedir: '/var/home/me' };
    expect(forbiddenRootReason('/var/home/me/Documents/x', silverblue)).toBeNull();
    expect(forbiddenRootReason('/var/home/me', silverblue)).toBe('user-home');
    expect(forbiddenRootReason('/var/home', silverblue)).toBe('home-container');
  });
});

describe('forbiddenRootReason — explicit folders', () => {
  const explicit = { explicit: true };

  it.each([
    ['/var/folders/xy/T/scratch', mac],
    ['/private/tmp/scratch', mac],
    ['/usr/local/src/widget', mac],
    ['/Users/me/.config/nvim', mac],
    ['/Users/me/Library/Application Support/Code/User', mac],
    ['/tmp/scratch', linux],
    ['/var/www/site', linux],
    ['/home/me/.config/nvim', linux],
    ['C:\\Users\\me\\AppData\\Local\\Temp\\scratch', win],
    ['C:\\Users\\me\\AppData\\Roaming\\Code\\User', win],
    ['C:\\Program Files\\Vendor\\Plugins', win],
  ] as const)('allows a folder the caller chose: %s', (path, ctx) => {
    expect(forbiddenRootReason(path, ctx, explicit)).toBeNull();
    // A document there is still never turned into a project.
    expect(forbiddenRootReason(path, ctx)).not.toBeNull();
  });

  it.each([
    ['/', mac, 'filesystem-root'],
    ['/Users/me', mac, 'user-home'],
    ['/var/folders/xy/T', mac, 'temp-dir'],
    ['/private/tmp', mac, 'temp-dir'],
    ['/usr', mac, 'system-dir'],
    ['/usr/local', mac, 'system-dir'],
    ['/Users/me/Library', mac, 'per-user-app-data'],
    ['/Users/me/Library/Preferences', mac, 'per-user-app-data'],
    ['/Users/me/.ssh', mac, 'hidden-home-dir'],
    ['/Users/me/.gezel/projects/x', mac, 'gezel-home'],
    ['/tmp', linux, 'temp-dir'],
    ['/var/lib/gezel/projects', linux, 'gezel-home'],
    ['/home/me/.config', linux, 'hidden-home-dir'],
    ['/home/me/.local/share', linux, 'per-user-app-data'],
    ['C:\\Users\\me\\AppData', win, 'per-user-app-data'],
    ['C:\\Users\\me\\AppData\\Roaming', win, 'per-user-app-data'],
    ['C:\\Users\\me\\AppData\\Local\\Temp', win, 'temp-dir'],
    ['C:\\Windows', win, 'system-dir'],
    ['C:\\Program Files\\Vendor', win, 'system-dir'],
  ] as const)('still refuses a folder too broad to be a project: %s', (path, ctx, reason) => {
    expect(forbiddenRootReason(path, ctx, explicit)).toBe(reason);
  });
});
