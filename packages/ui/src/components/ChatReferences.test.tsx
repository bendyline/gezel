import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_RAIL_MIN_SPLIT_PX, ChatReferences } from './ChatReferences.js';

vi.mock('./CommandsPanel.js', () => ({
  CommandsPanel: () => <div data-testid="commands-panel" />,
}));

let activeWidth = 0;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => activeWidth,
  });
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(): void {
      queueMicrotask(() => this.cb([], this as unknown as ResizeObserver));
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
});

function renderProjectRail() {
  return render(
    <ChatReferences chatKey="project-1" projectId="project-1" commandsProjectId="project-1">
      {() => <div data-testid="chat-main" />}
    </ChatReferences>,
  );
}

describe('ChatReferences responsive split', () => {
  it('drops the right pane before the chat would fall below its minimum width', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX - 1;
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-compact')).not.toBeNull();
    });
    expect(container.querySelector('aside')).toBeNull();
    expect(screen.queryByTestId('commands-panel')).not.toBeInTheDocument();
  });

  it('keeps the right pane at the minimum viable split width', async () => {
    activeWidth = CHAT_RAIL_MIN_SPLIT_PX;
    const { container } = renderProjectRail();

    await waitFor(() => {
      expect(container.querySelector('.chat-rail-body-split')).not.toBeNull();
    });
    expect(container.querySelector('aside')).not.toBeNull();
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
  });
});
