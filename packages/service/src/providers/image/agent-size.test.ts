import { describe, expect, it } from 'vitest';

import { capAgentImageSize } from './agent-size.js';

describe('capAgentImageSize', () => {
  it('keeps modest requests unchanged', () => {
    expect(capAgentImageSize({ width: 512 })).toEqual({ width: 512 });
    expect(capAgentImageSize({})).toEqual({});
  });

  it('caps oversized two-dimensional requests while preserving aspect ratio', () => {
    expect(capAgentImageSize({ width: 1600, height: 900 })).toEqual({
      width: 1024,
      height: 576,
      note: 'Request normalized for agent image generation (size 1600x900 -> 1024x576).',
    });
  });

  it('caps a single oversized dimension', () => {
    expect(capAgentImageSize({ width: 2048 })).toEqual({
      width: 1024,
      note: 'Request normalized for agent image generation (width 2048 -> 1024).',
    });
    expect(capAgentImageSize({ height: 1536 })).toEqual({
      height: 1024,
      note: 'Request normalized for agent image generation (height 1536 -> 1024).',
    });
  });
});
