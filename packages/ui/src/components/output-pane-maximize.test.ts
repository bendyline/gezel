import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestOutputPaneFullWindow, takeOutputPaneFullWindow } from './output-pane-maximize.js';

describe('opening the Output page full window', () => {
  afterEach(() => vi.useRealTimers());

  it('is taken once, by the project it was asked for', () => {
    requestOutputPaneFullWindow('trip');
    expect(takeOutputPaneFullWindow('other')).toBe(false);
    expect(takeOutputPaneFullWindow('trip')).toBe(true);
    expect(takeOutputPaneFullWindow('trip')).toBe(false);
  });

  it('lapses, so a later visit opens as it normally would', () => {
    vi.useFakeTimers();
    requestOutputPaneFullWindow('trip');
    vi.advanceTimersByTime(31_000);
    expect(takeOutputPaneFullWindow('trip')).toBe(false);
  });
});
