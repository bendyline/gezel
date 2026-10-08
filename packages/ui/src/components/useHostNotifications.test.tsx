import type { ChatEventEnvelope } from '@bendyline/gezel';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

let pushEvent: ((env: ChatEventEnvelope) => void) | undefined;
vi.mock('../shared-chat-events.js', () => ({
  async *streamSharedAllChatEvents(opts: { signal?: AbortSignal }) {
    const queue: ChatEventEnvelope[] = [];
    let wake: (() => void) | undefined;
    pushEvent = (env) => {
      queue.push(env);
      wake?.();
    };
    while (!opts.signal?.aborted) {
      const next = queue.shift();
      if (next) yield next;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  },
}));

const { useHostNotifications, reminderNotificationId } = await import('./useHostNotifications.js');
const { api } = await import('../api.js');
const { NotificationsSetting } = await import('./NotificationsSetting.js');

function Host() {
  useHostNotifications();
  return null;
}

function bridge() {
  return {
    notify: vi.fn(async () => {}),
    scheduleReminders: vi.fn(async () => {}),
    clearDelivered: vi.fn(async () => {}),
    requestPermission: vi.fn(async () => {}),
  };
}

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility,
});

describe('host notifications (phone)', () => {
  beforeEach(() => {
    visibility = 'visible';
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] } as never);
  });
  afterEach(() => {
    delete (window as { __GEZEL__?: unknown }).__GEZEL__;
  });

  it('does nothing where the host owns notifications (the desktop)', async () => {
    window.__GEZEL__ = {} as never;
    render(<Host />);
    await act(async () => {});
    expect(api.listReminders).not.toHaveBeenCalled();
  });

  it('hands project reminders to the OS, asks permission in context, and clears the tray on return', async () => {
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const reminder = { projectId: 'cards', at, title: 'Flashcards are due', setAt: at };
    vi.mocked(api.listReminders).mockResolvedValue({ reminders: [reminder] });
    const host = bridge();
    window.__GEZEL__ = { earnedNotifications: host } as never;
    render(<Host />);
    await waitFor(() =>
      expect(host.scheduleReminders).toHaveBeenCalledWith([
        { id: reminderNotificationId(reminder), at, title: 'Flashcards are due', body: '' },
      ]),
    );

    await waitFor(() => expect(pushEvent).toBeDefined());
    act(() =>
      pushEvent!({
        sessionId: 's1',
        gezelId: 'wren',
        projectId: 'default',
        event: {
          type: 'question_asked',
          question: {
            id: 'q1',
            projectId: 'default',
            gezelId: 'wren',
            sessionId: 's1',
            prompt: 'Which week suits you?',
            createdAt: at,
          },
        },
      }),
    );
    await waitFor(() => expect(host.requestPermission).toHaveBeenCalled());

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(host.clearDelivered).toHaveBeenCalled();
  });
});

describe('NotificationsSetting', () => {
  it('saves the daily allowance and asks for permission when turned on', async () => {
    const host = bridge();
    window.__GEZEL__ = { earnedNotifications: host } as never;
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'mock',
      notifications: { dailyCap: 5 },
    } as never);
    const view = render(<NotificationsSetting />);
    const three = await view.findByRole('radio', { name: '3' });
    await waitFor(() => expect(three).toHaveAttribute('aria-checked', 'true'));
    await act(async () => {
      view.getByRole('radio', { name: '5' }).click();
    });
    expect(api.updateConfig).toHaveBeenCalledWith({ notifications: { dailyCap: 5 } });
    expect(host.requestPermission).toHaveBeenCalled();
    delete (window as { __GEZEL__?: unknown }).__GEZEL__;
  });
});
