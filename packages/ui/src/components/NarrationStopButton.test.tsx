import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderDensityContext } from './header-density.js';

/** Stands in for the shared narration queue: speaking is whatever the test says. */
const queue = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const fake = {
    active: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: vi.fn(() => fake.set(false)),
    set(active: boolean) {
      fake.active = active;
      for (const listener of listeners) listener();
    },
  };
  return fake;
});

vi.mock('./narration-queue.js', () => ({ chatNarrationQueue: queue }));

const { NarrationStopButton } = await import('./NarrationStopButton.js');

describe('NarrationStopButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queue.active = false;
    queue.stop.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent while nothing is being read aloud', () => {
    render(<NarrationStopButton />);
    expect(screen.queryByRole('button', { name: 'Stop narration' })).toBeNull();
  });

  it('appears when a gezel starts speaking and stops the voice when pressed', () => {
    render(<NarrationStopButton />);
    act(() => queue.set(true));
    fireEvent.click(screen.getByRole('button', { name: 'Stop narration' }));
    expect(queue.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Stop narration' })).toBeNull();
  });

  it('stays through the short gap between two sentences', () => {
    render(<NarrationStopButton />);
    act(() => queue.set(true));
    act(() => queue.set(false));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => queue.set(true));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole('button', { name: 'Stop narration' })).toBeTruthy();
  });

  it('leaves once the voice has been quiet for a moment', () => {
    render(<NarrationStopButton />);
    act(() => queue.set(true));
    act(() => queue.set(false));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByRole('button', { name: 'Stop narration' })).toBeNull();
  });

  it('drops its words before the titlebar runs out of room', () => {
    queue.active = true;
    const { rerender } = render(
      <HeaderDensityContext.Provider value="full">
        <NarrationStopButton />
      </HeaderDensityContext.Provider>,
    );
    expect(screen.getByText('Stop narration')).toBeTruthy();
    rerender(
      <HeaderDensityContext.Provider value="compact">
        <NarrationStopButton />
      </HeaderDensityContext.Provider>,
    );
    expect(screen.queryByText('Stop narration')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop narration' })).toBeTruthy();
  });
});
