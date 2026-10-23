import type { GezelClient } from '@bendyline/gezel-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMacroProjectGuard,
  lookupMacroIdempotent,
  recordMacroResult,
} from './macro-idempotency.js';

type GuardApi = Pick<GezelClient, 'listProjects' | 'listProjectTasks'>;

function guard(api: Partial<Record<keyof GuardApi, unknown>>) {
  return createMacroProjectGuard(api as unknown as GuardApi);
}

function noticeText(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the macro idempotency cache', () => {
  it('replays a result recorded under the same name, whatever its case and spacing', () => {
    expect(lookupMacroIdempotent('Arcade Game')).toBeNull();
    recordMacroResult('start_job', 'Arcade Game', 'arcade-game', 'Started Arcade Game.');
    expect(lookupMacroIdempotent('  arcade   GAME ')).toEqual({
      tool: 'start_job',
      projectId: 'arcade-game',
      resultText: 'Started Arcade Game.',
    });
  });

  it('forgets a result after a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    recordMacroResult('start_project', 'Recipe Box', 'recipe-box', 'Started Recipe Box.');
    vi.setSystemTime(new Date('2026-10-22T12:00:59Z'));
    expect(lookupMacroIdempotent('Recipe Box')?.projectId).toBe('recipe-box');
    vi.setSystemTime(new Date('2026-10-22T12:01:01Z'));
    expect(lookupMacroIdempotent('Recipe Box')).toBeNull();
  });
});

describe('findActiveMacroProject', () => {
  it('finds an active project by its normalized name and skips archived ones', async () => {
    const listProjects = vi.fn(async () => ({
      projects: [
        { id: 'old', name: 'Customer List Cleanup', status: 'archived' },
        { id: 'live', name: 'customer  list cleanup' },
      ],
    }));
    const { findActiveMacroProject } = guard({ listProjects });
    await expect(findActiveMacroProject('Customer List Cleanup')).resolves.toEqual({
      id: 'live',
      name: 'customer  list cleanup',
    });
    await expect(findActiveMacroProject('Something Else')).resolves.toBeNull();
  });

  it('answers no project when the list cannot be read', async () => {
    const { findActiveMacroProject } = guard({
      listProjects: vi.fn(async () => {
        throw new Error('daemon unavailable');
      }),
    });
    await expect(findActiveMacroProject('Arcade Game')).resolves.toBeNull();
  });
});

describe('duplicateMacroProjectNotice', () => {
  const existing = { id: 'cleanup', name: 'Customer List Cleanup' };

  it('says the lead is on it while a kickoff task is running', async () => {
    const listProjectTasks = vi.fn(async () => ({ tasks: [{ status: 'active' }] }));
    const { duplicateMacroProjectNotice } = guard({ listProjectTasks });
    const text = noticeText(await duplicateMacroProjectNotice('start_job', existing));
    expect(listProjectTasks).toHaveBeenCalledWith('cleanup');
    expect(text).toContain('is already active and its lead is on this deliverable');
    expect(text).toContain('Do NOT `start_job` again');
  });

  it('points at the existing project when only scheduled or finished work is there', async () => {
    const { duplicateMacroProjectNotice } = guard({
      listProjectTasks: vi.fn(async () => ({
        tasks: [
          { status: 'active', cron: '0 3 * * *' },
          { status: 'active', nightShift: true },
          { status: 'completed' },
        ],
      })),
    });
    const text = noticeText(await duplicateMacroProjectNotice('start_work', existing));
    expect(text).toContain('no work is running in it yet');
    expect(text).toContain('suggest_work({ project: "cleanup" })');
    expect(text).not.toContain('its lead is on this deliverable');
  });

  it('assumes work is running when the tasks cannot be read', async () => {
    const { duplicateMacroProjectNotice } = guard({
      listProjectTasks: vi.fn(async () => {
        throw new Error('daemon unavailable');
      }),
    });
    const text = noticeText(await duplicateMacroProjectNotice('start_project', existing));
    expect(text).toContain('Do NOT `start_project` again');
  });
});
