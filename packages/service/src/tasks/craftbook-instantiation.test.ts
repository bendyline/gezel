import type { TaskCraftbookStep } from '@bendyline/gezel';
import { expect, it } from 'vitest';
import { craftbookParamDefaults, interpolateStepsContext } from './craftbook-instantiation.js';

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
