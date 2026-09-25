import { describe, expect, it } from 'vitest';
import {
  backupEntryPrefix,
  backupItemIdentity,
  backupSettingsTarget,
  isBackupDerivedPath,
  isBackupSettingsFileId,
  selectBackupItems,
} from './backup-policy.js';

describe('backupEntryPrefix', () => {
  it('maps every item kind to its archive prefix', () => {
    expect(backupEntryPrefix({ kind: 'project', id: 'alpha' })).toBe('projects/alpha');
    expect(backupEntryPrefix({ kind: 'gezel', id: 'maya' })).toBe('gezels/maya');
    expect(backupEntryPrefix({ kind: 'document-root', id: 'documents' })).toBe('documents');
    expect(backupEntryPrefix({ kind: 'settings-file', id: 'config.json' })).toBe(
      'settings/config.json',
    );
    // The desktop has always emitted this one; the portable reader used to refuse it.
    expect(backupEntryPrefix({ kind: 'settings-file', id: 'history.jsonl' })).toBe(
      'settings/history.jsonl',
    );
  });

  it('refuses ids it cannot place', () => {
    expect(() => backupEntryPrefix({ kind: 'settings-file', id: 'secrets.json' })).toThrow();
    expect(() => backupEntryPrefix({ kind: 'document-root', id: 'other' })).toThrow();
    expect(() => backupEntryPrefix({ kind: 'project', id: '../up' })).toThrow();
  });

  it('names settings targets and identities', () => {
    expect(backupSettingsTarget('config.json')).toBe('config.json');
    expect(isBackupSettingsFileId('history.jsonl')).toBe(true);
    expect(isBackupSettingsFileId('x')).toBe(false);
    expect(backupItemIdentity({ kind: 'gezel', id: 'maya' })).toBe('gezel/maya');
  });
});

describe('isBackupDerivedPath', () => {
  it.each([
    'gezels/maya/memories/index/vectors.db',
    'gezels/maya/toolsets',
    'projects/alpha/_index/x',
    'projects/alpha/index/x',
    'projects/alpha/memories/index/x',
    'projects/alpha/artifacts/shadow/x',
    'projects/alpha/artifacts/.tabular/x',
    'projects/alpha/toolsets/x',
    'projects/alpha/terminals/x',
    'projects/alpha/.gezel/index/x',
    'projects/alpha/.gezel/terminals/x',
  ])('excludes %s', (path) => {
    expect(isBackupDerivedPath(path)).toBe(true);
  });

  it.each([
    'projects/alpha/workspace/index/notes.md',
    'projects/alpha/project.json',
    'projects/alpha/scripts/runs/2026-09-22/r.json',
    'gezels/maya/memories/daily/2026-09-22.md',
    'documents/index.md',
  ])('keeps %s', (path) => {
    expect(isBackupDerivedPath(path)).toBe(false);
  });
});

describe('selectBackupItems', () => {
  const items = [
    { kind: 'gezel', id: 'a' },
    { kind: 'gezel', id: 'b' },
    { kind: 'project', id: 'p' },
    { kind: 'document-root', id: 'documents' },
    { kind: 'settings-file', id: 'config.json' },
  ] as const;
  it('keeps everything without an include list', () => {
    expect(selectBackupItems(items, undefined)).toHaveLength(5);
  });
  it('narrows by list and by flag', () => {
    const out = selectBackupItems(items, { gezels: ['b'], documents: false, settings: false });
    expect(out.map(backupItemIdentity)).toEqual(['gezel/b', 'project/p']);
  });
});
