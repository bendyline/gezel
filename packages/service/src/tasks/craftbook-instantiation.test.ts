import type { TaskCraftbookStep } from '@bendyline/gezel';
import { expect, it } from 'vitest';
import {
  craftbookParamDefaults,
  interpolateStepsContext,
  pinCraftbookOwner,
} from './craftbook-instantiation.js';

it('retains numeric and boolean defaults without prematurely expanding task paths', () => {
  expect(
    craftbookParamDefaults({
      properties: {
        limit: { default: 3 },
        enabled: { default: false },
        workPath: { default: '{{task.dir}}' },
        data: { default: {} },
      },
    }),
  ).toEqual({ limit: '3', enabled: 'false', workPath: '{{task.dir}}' });
});

it('binds independent model gezels without mutating the recipe assignee', () => {
  const assignee = { kind: 'gezel' as const, gezelId: '{{reviewer}}' };
  const steps = [
    { id: 'write', suggestedGezelId: '{{writer}}' },
    { id: 'review', assignee },
  ] as TaskCraftbookStep[];
  interpolateStepsContext(steps, { writer: 'gemma', reviewer: 'muse' });
  expect(steps[0]?.suggestedGezelId).toBe('gemma');
  expect(steps[1]?.assignee).toEqual({ kind: 'gezel', gezelId: 'muse' });
  expect(assignee.gezelId).toBe('{{reviewer}}');
});

it('pinCraftbookOwner pins role-resolved steps to the owner and leaves explicit bindings alone', () => {
  const steps: TaskCraftbookStep[] = [
    { id: 'a', name: 'A', suggestedRole: 'researcher', suggestedGezelId: 'stale-specialist' },
    { id: 'b', name: 'B', suggestedRole: 'developer' },
    { id: 'c', name: 'C', assignee: { kind: 'user' } },
    { id: 'd', name: 'D', assignee: { kind: 'gezel', gezelId: 'other' } },
    { id: 'e', name: 'E', assignee: { kind: 'gezel', gezelId: 'owner' }, suggestedGezelId: 'x' },
  ] as TaskCraftbookStep[];
  pinCraftbookOwner(steps, 'owner');
  expect(steps[0]).toEqual({
    id: 'a',
    name: 'A',
    suggestedRole: 'researcher',
    assignee: { kind: 'gezel', gezelId: 'owner' },
  });
  expect(steps[1]!.assignee).toEqual({ kind: 'gezel', gezelId: 'owner' });
  expect(steps[1]!.suggestedRole).toBe('developer');
  expect(steps[2]!.assignee).toEqual({ kind: 'user' });
  expect(steps[3]!.assignee).toEqual({ kind: 'gezel', gezelId: 'other' });
  expect(steps[4]).toEqual({ id: 'e', name: 'E', assignee: { kind: 'gezel', gezelId: 'owner' } });
});
