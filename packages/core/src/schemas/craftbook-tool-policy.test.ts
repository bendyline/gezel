import { describe, expect, it } from 'vitest';
import { CraftbookStepToolPolicySchema } from './craftbook.js';

describe('craftbook exact tool policy', () => {
  it('allows removing artifact search while retaining artifact output', () => {
    expect(
      CraftbookStepToolPolicySchema.parse({
        outputMedium: 'artifact',
        disallowTools: ['list_artifacts', 'grep_artifact', 'read_doc_as_markdown'],
      }).disallowTools,
    ).toEqual(['list_artifacts', 'grep_artifact', 'read_doc_as_markdown']);
  });
  it('rejects removal of workflow safety and required output tools', () => {
    expect(
      CraftbookStepToolPolicySchema.safeParse({ disallowTools: ['advance_task_step'] }).success,
    ).toBe(false);
    expect(
      CraftbookStepToolPolicySchema.safeParse({
        outputMedium: 'artifact',
        disallowTools: ['write_artifact'],
      }).success,
    ).toBe(false);
  });
  it('accepts a fixed read-action ceiling but requires its artifact writer in the observation step', () => {
    expect(
      CraftbookStepToolPolicySchema.parse({
        outputMedium: 'none',
        allowTools: ['read_artifact', 'read_artifacts'],
      }).allowTools,
    ).toEqual(['read_artifact', 'read_artifacts']);
    expect(
      CraftbookStepToolPolicySchema.safeParse({
        outputMedium: 'artifact',
        allowTools: ['read_artifact', 'read_artifacts'],
      }).success,
    ).toBe(false);
    expect(
      CraftbookStepToolPolicySchema.parse({
        outputMedium: 'artifact',
        allowTools: ['read_artifact', 'read_artifacts', 'write_artifact'],
      }).allowTools,
    ).toContain('write_artifact');
  });
  it('rejects contradictory exact allow and deny entries', () => {
    expect(
      CraftbookStepToolPolicySchema.safeParse({
        allowTools: ['read_artifact'],
        disallowTools: ['read_artifact'],
      }).success,
    ).toBe(false);
  });
});
