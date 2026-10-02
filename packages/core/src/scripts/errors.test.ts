import { describe, expect, it } from 'vitest';
import { inferScriptScope } from './errors.js';

describe('inferScriptScope', () => {
  const installed = [
    { name: 'storeRecords', scope: 'standard' },
    { name: 'report', scope: 'user' },
    { name: 'report', scope: 'project' },
  ];

  it('keeps an explicit scope, and otherwise prefers project, then user, then standard', () => {
    expect(inferScriptScope('storeRecords', 'project', installed)).toBe('project');
    expect(inferScriptScope('storeRecords', undefined, installed)).toBe('standard');
    expect(inferScriptScope('report', undefined, installed)).toBe('project');
    expect(inferScriptScope('report', undefined, installed.slice(0, 2))).toBe('user');
  });

  it('answers the project when nothing matches, so not-found names where it looked', () => {
    expect(inferScriptScope('missing', undefined, installed)).toBe('project');
  });
});
