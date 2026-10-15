import type { HistoryEvent } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  inspectProjectJson,
  parseProjectHistory,
  rebuildProjectFromHistory,
} from './project-meta-recovery.js';

const NULS = '\u0000'.repeat(217);

function event(kind: string, at: string, extra: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: `${kind}-${at}`,
    at,
    kind,
    summary: kind,
    projectId: 'vampire-hunter-game',
    ...extra,
  } as HistoryEvent;
}

describe('inspectProjectJson', () => {
  it('passes valid JSON through', () => {
    expect(inspectProjectJson('{"id":"a"}\n')).toEqual({ kind: 'valid', value: { id: 'a' } });
  });

  it('calls an all-NUL or empty file crash damage', () => {
    expect(inspectProjectJson(NULS)).toEqual({ kind: 'crash-damaged' });
    expect(inspectProjectJson('')).toEqual({ kind: 'crash-damaged' });
    expect(inspectProjectJson('  \n')).toEqual({ kind: 'crash-damaged' });
  });

  it('salvages JSON behind a byte-order mark or beside stray NULs', () => {
    expect(inspectProjectJson('﻿{"id":"a"}')).toEqual({ kind: 'salvaged', value: { id: 'a' } });
    expect(inspectProjectJson('{"id":"a"}\u0000\u0000')).toEqual({
      kind: 'salvaged',
      value: { id: 'a' },
    });
  });

  it('calls torn content with NULs crash damage', () => {
    expect(inspectProjectJson('{"id":"a","na\u0000\u0000')).toEqual({ kind: 'crash-damaged' });
  });

  it('leaves plain malformed text to the person', () => {
    expect(inspectProjectJson('{"id": "a",, }')).toEqual({ kind: 'malformed' });
  });
});

describe('parseProjectHistory', () => {
  it('recovers a line that an interrupted write prefixed with NULs, and skips torn ones', () => {
    const good = JSON.stringify(event('project.created', '2026-05-28T03:18:29.816Z'));
    const after = JSON.stringify(event('project.gezel.joined', '2026-05-28T03:19:00.000Z'));
    const raw = `${good}\n{"id":"torn\n${'\u0000'.repeat(40)}${after}\n`;
    expect(parseProjectHistory(raw).map((e) => e.kind)).toEqual([
      'project.created',
      'project.gezel.joined',
    ]);
  });
});

describe('rebuildProjectFromHistory', () => {
  const fallback = '2026-05-27T00:00:00.000Z';

  it('replays identity, lead, roster and status in time order', () => {
    const events = [
      event('project.gezel.left', '2026-05-28T04:00:00.000Z', { gezelId: 'kenji' }),
      event('project.created', '2026-05-28T03:18:29.816Z', {
        details: { name: 'Vampire Hunter Game', description: 'A game' },
      }),
      event('project.voorman.changed', '2026-05-28T03:18:29.952Z', {
        details: { voormanGezelId: 'rangi' },
      }),
      event('project.gezel.joined', '2026-05-28T03:18:29.957Z', { gezelId: 'rangi' }),
      event('project.gezel.joined', '2026-05-28T03:19:00.000Z', { gezelId: 'kenji' }),
      event('project.updated', '2026-05-28T03:30:00.000Z', {
        details: { changed: ['name'], patch: { name: 'Vampire Hunter' } },
      }),
      event('project.status.changed', '2026-05-28T03:31:00.000Z', {
        details: { status: 'stable' },
      }),
      event('project.created', '2026-05-28T03:00:00.000Z', {
        projectId: 'another-project',
        details: { name: 'Not this one' },
      }),
    ];
    expect(rebuildProjectFromHistory('vampire-hunter-game', events, fallback)).toEqual({
      id: 'vampire-hunter-game',
      name: 'Vampire Hunter',
      description: 'A game',
      voormanGezelId: 'rangi',
      gezelIds: ['rangi'],
      status: 'stable',
      createdAt: '2026-05-28T03:18:29.816Z',
      updatedAt: '2026-05-28T04:00:00.000Z',
    });
  });

  it('restores an opened folder with check-ins off, as createProject made it', () => {
    const rebuilt = rebuildProjectFromHistory(
      'vampire-hunter-game',
      [
        event('project.created', '2026-05-28T03:18:29.816Z', {
          details: { name: 'Game', workingDir: '/work/game' },
        }),
      ],
      fallback,
    );
    expect(rebuilt).toMatchObject({ workingDir: '/work/game', nudgeConfig: { enabled: false } });
  });

  it('never replays grants logged inside an update patch', () => {
    const rebuilt = rebuildProjectFromHistory(
      'vampire-hunter-game',
      [
        event('project.created', '2026-05-28T03:18:29.816Z', { details: { name: 'Game' } }),
        event('project.updated', '2026-05-28T03:20:00.000Z', {
          details: {
            changed: ['description'],
            patch: {
              description: 'Now with stakes',
              managedWorkspaceWritePolicy: 'allow',
              grantedCredentials: ['github'],
              claudePermissionMode: 'bypassPermissions',
            },
          },
        }),
      ],
      fallback,
    );
    expect(rebuilt.description).toBe('Now with stakes');
    expect(rebuilt.managedWorkspaceWritePolicy).toBeUndefined();
    expect(rebuilt.grantedCredentials).toBeUndefined();
    expect(rebuilt.claudePermissionMode).toBeUndefined();
  });

  it('names a project with no history after its id', () => {
    expect(rebuildProjectFromHistory('vampire-hunter-game', [], fallback)).toEqual({
      id: 'vampire-hunter-game',
      name: 'Vampire Hunter Game',
      createdAt: fallback,
      updatedAt: fallback,
    });
  });
});
