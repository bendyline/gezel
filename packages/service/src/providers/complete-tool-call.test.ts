import { describe, expect, it } from 'vitest';
import { hasCompleteToolCallMarkup } from './complete-tool-call.js';

describe('hasCompleteToolCallMarkup', () => {
  it('recognizes a closed JSON envelope — the 2026-09-23 shape', () => {
    const call =
      '\n\n<tool_call>\n{\n"name": "invoke_craftbook",\n"arguments": {"craftbookId": "powerpoint-deck"}\n}\n</tool_call>';
    expect(hasCompleteToolCallMarkup(call.slice(0, -3))).toBe(false);
    expect(hasCompleteToolCallMarkup(call)).toBe(true);
  });

  it('waits for the outer </tool_call> of a Hermes call, not the inner </function>', () => {
    const inner =
      '<tool_call>\n<function=invoke_craftbook>\n<parameter=params>\n{"topic": "Pizza"}\n</parameter>\n</function>';
    expect(hasCompleteToolCallMarkup(inner)).toBe(false);
    expect(hasCompleteToolCallMarkup(`${inner}\n</tool_call>`)).toBe(true);
  });

  it('accepts a bare Hermes block and a Claude-style invoke', () => {
    expect(hasCompleteToolCallMarkup('<function=list_tasks>\n</function>')).toBe(true);
    expect(hasCompleteToolCallMarkup('<invoke name="list_tasks"></invoke>')).toBe(true);
    expect(hasCompleteToolCallMarkup('<function_calls>\n<invoke name="list_tasks"></invoke>')).toBe(
      false,
    );
  });

  it('ignores prose and orphan closers', () => {
    expect(hasCompleteToolCallMarkup('I will start the deck now.')).toBe(false);
    expect(hasCompleteToolCallMarkup('</function>\n</function>\n')).toBe(false);
  });
});
