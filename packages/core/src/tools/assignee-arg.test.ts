import { describe, expect, it } from 'vitest';
import { assigneeArg, normalizeAssigneeArg } from './assignee-arg.js';

describe('normalizeAssigneeArg', () => {
  it('treats a bare string as a gezel reference', () => {
    expect(normalizeAssigneeArg('wren')).toEqual({ kind: 'gezel', ref: 'wren' });
    expect(normalizeAssigneeArg('  Rina  ')).toEqual({ kind: 'gezel', ref: 'Rina' });
  });

  it('recognizes the user', () => {
    expect(normalizeAssigneeArg('user')).toEqual({ kind: 'user' });
    expect(normalizeAssigneeArg('The User')).toEqual({ kind: 'user' });
    expect(normalizeAssigneeArg({ kind: 'user' })).toEqual({ kind: 'user' });
  });

  it('keeps concrete instructions through object and textual tool arguments', () => {
    const instructions = 'Add the launch date to the description, then confirm it in your reply.';
    const input = { kind: 'user', instructions: `  ${instructions}  ` };
    for (const raw of [input, JSON.stringify(input)]) {
      expect(normalizeAssigneeArg(assigneeArg().parse(raw))).toEqual({
        kind: 'user',
        instructions,
      });
    }
    expect(assigneeArg().safeParse({ kind: 'user', instructions: '  ' }).success).toBe(false);
  });

  it('accepts the legacy object form', () => {
    expect(normalizeAssigneeArg({ kind: 'gezel', gezelId: 'wren' })).toEqual({
      kind: 'gezel',
      ref: 'wren',
    });
  });

  // The failure this argument shape exists to prevent: a router model read
  // kind="gezel" as "have a gezel do it" and left gezelId out, which used to
  // abort the whole invoke_craftbook call.
  it('reads a kind without an id as "no one in particular"', () => {
    expect(normalizeAssigneeArg({ kind: 'gezel' })).toBeNull();
    expect(normalizeAssigneeArg({ kind: 'gezel', gezelId: '' })).toBeNull();
    expect(normalizeAssigneeArg({ kind: 'gezel', gezelId: '  ' })).toBeNull();
  });

  it('reads placeholder words as "no one in particular"', () => {
    for (const raw of ['gezel', 'a gezel', 'any', 'auto', 'unassigned', 'none', 'TBD', '']) {
      expect(normalizeAssigneeArg(raw)).toBeNull();
    }
    expect(normalizeAssigneeArg({ kind: 'gezel', gezelId: 'any gezel' })).toBeNull();
  });

  it('passes through an absent argument', () => {
    expect(normalizeAssigneeArg(undefined)).toBeNull();
    expect(normalizeAssigneeArg(null)).toBeNull();
  });
});

describe('assigneeArg schema', () => {
  const schema = assigneeArg();

  it('accepts a string, an object, and a stringified object', () => {
    expect(schema.parse('wren')).toBe('wren');
    expect(schema.parse({ kind: 'user' })).toEqual({ kind: 'user' });
    expect(schema.parse('{"kind":"gezel","gezelId":"wren"}')).toEqual({
      kind: 'gezel',
      gezelId: 'wren',
    });
  });

  it('accepts an object that omits gezelId', () => {
    expect(schema.parse({ kind: 'gezel' })).toEqual({ kind: 'gezel' });
  });
});
