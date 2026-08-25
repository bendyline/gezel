import { describe, expect, it } from 'vitest';
import { seedParamDefaults } from './new-task-meta.js';

describe('seedParamDefaults', () => {
  it('seeds plain declared defaults', () => {
    const schema = {
      properties: {
        intensity: { type: 'string', default: 'medium' },
        dryRun: { type: 'boolean', default: false },
      },
    };
    expect(seedParamDefaults(schema)).toEqual({ intensity: 'medium', dryRun: false });
  });

  it('leaves runtime-template defaults unseeded so the server resolves them', () => {
    const schema = {
      properties: {
        workPath: { type: 'string', default: '{{task.dir}}' },
        focus: { type: 'string', default: 'everything' },
      },
    };
    expect(seedParamDefaults(schema)).toEqual({ focus: 'everything' });
  });

  it('handles a schema without properties', () => {
    expect(seedParamDefaults(undefined)).toEqual({});
    expect(seedParamDefaults({})).toEqual({});
  });
});
