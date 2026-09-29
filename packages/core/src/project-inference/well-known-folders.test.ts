import { describe, expect, it } from 'vitest';
import {
  classifyCloudStorageEntry,
  parseUserDirs,
  wellKnownFolderFor,
  wellKnownFolders,
} from './well-known-folders.js';

describe('wellKnownFolders — win32', () => {
  const folders = wellKnownFolders({
    platform: 'win32',
    homedir: 'C:\\Users\\me',
    env: { OneDrive: 'C:\\Users\\me\\OneDrive - Contoso' },
  });

  it('lists the default known folders under the profile', () => {
    const docs = folders.find((f) => f.kind === 'documents' && f.source === 'default');
    expect(docs?.path).toBe('C:\\Users\\me\\Documents');
    expect(folders.find((f) => f.kind === 'videos')?.path).toBe('C:\\Users\\me\\Videos');
  });

  it('adds OneDrive from the environment with Known Folder Move children', () => {
    const root = folders.find((f) => f.kind === 'cloud' && f.cloud === 'onedrive');
    expect(root?.path).toBe('C:\\Users\\me\\OneDrive - Contoso');
    const kfm = folders.find(
      (f) =>
        f.source === 'cloud-child' && f.path === 'C:\\Users\\me\\OneDrive - Contoso\\Documents',
    );
    expect(kfm?.kind).toBe('documents');
    expect(kfm?.cloud).toBe('onedrive');
  });

  it('resolves the deepest containing folder', () => {
    const w = wellKnownFolderFor(
      'c:\\users\\me\\onedrive - contoso\\documents\\plans',
      folders,
      'win32',
    );
    expect(w?.source).toBe('cloud-child');
    expect(w?.kind).toBe('documents');
  });
});

describe('wellKnownFolders — darwin', () => {
  const folders = wellKnownFolders({
    platform: 'darwin',
    homedir: '/Users/me',
    env: {},
    cloudStorageEntries: [
      'OneDrive-Personal',
      'GoogleDrive-me@example.com',
      'Dropbox',
      '.DS_Store',
    ],
  });

  it('maps Movies to videos', () => {
    const movies = folders.find((f) => f.path === '/Users/me/Movies');
    expect(movies?.kind).toBe('videos');
    expect(movies?.label).toBe('Movies');
  });

  it('includes iCloud Drive and its Documents child', () => {
    const icloud = '/Users/me/Library/Mobile Documents/com~apple~CloudDocs';
    expect(folders.find((f) => f.path === icloud)?.cloud).toBe('icloud');
    expect(folders.find((f) => f.path === `${icloud}/Documents`)?.kind).toBe('documents');
  });

  it('classifies CloudStorage entries and labels them', () => {
    const names = folders.filter((f) => f.path.includes('/CloudStorage/')).map((f) => f.label);
    expect(names).toContain('OneDrive');
    expect(names).toContain('Google Drive');
    expect(names).toContain('Dropbox');
    expect(folders.some((f) => f.path.endsWith('.DS_Store'))).toBe(false);
  });
});

describe('wellKnownFolders — linux', () => {
  it('prefers user-dirs.dirs, then env, and skips disabled entries', () => {
    const folders = wellKnownFolders({
      platform: 'linux',
      homedir: '/home/me',
      env: { XDG_MUSIC_DIR: '/data/music' },
      userDirs: [
        '# comment',
        'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
        'XDG_DESKTOP_DIR="$HOME/"',
        'XDG_PICTURES_DIR="/srv/photos"',
      ].join('\n'),
    });
    expect(folders.find((f) => f.kind === 'documents')?.path).toBe('/home/me/Dokumente');
    expect(folders.find((f) => f.kind === 'pictures')?.path).toBe('/srv/photos');
    expect(folders.find((f) => f.kind === 'music')?.path).toBe('/data/music');
    // Desktop pointed at $HOME (disabled) → the default fallback is used.
    expect(folders.find((f) => f.kind === 'desktop')?.path).toBe('/home/me/Desktop');
    expect(folders.filter((f) => f.kind === 'documents')).toHaveLength(1);
  });
});

describe('parseUserDirs', () => {
  it('expands $HOME and ignores relative values', () => {
    expect(
      parseUserDirs('XDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_VIDEOS_DIR="Videos"', '/home/me'),
    ).toEqual({ XDG_DOWNLOAD_DIR: '/home/me/Downloads' });
  });
});

describe('classifyCloudStorageEntry', () => {
  it.each([
    ['OneDrive-Personal', 'onedrive'],
    ['OneDrive-SharedLibraries-Contoso', 'onedrive'],
    ['GoogleDrive-me@x.com', 'gdrive'],
    ['Box-Box', 'box'],
    ['Dropbox', 'dropbox'],
    ['SomethingElse', 'other'],
    ['.hidden', null],
  ] as const)('%s → %s', (name, provider) => {
    expect(classifyCloudStorageEntry(name)).toBe(provider);
  });
});
