import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountStartup } from './screen.js';
import type { StartupHomeBridge } from './types.js';

function bridge(): StartupHomeBridge {
  return {
    active: true,
    snapshot: null,
    state: {
      tab: 'greeting',
      article: 0,
      scroll: 0,
      draft: '',
      focused: false,
      selectionStart: 0,
      selectionEnd: 0,
    },
    save: vi.fn(() => true),
    finish: vi.fn(() => true),
  };
}
afterEach(() => {
  document.body.replaceChildren();
  delete window.__GEZEL_STARTUP__;
  vi.useRealTimers();
});

it('offers keyboard navigation and carries reading selection and a previously saved draft into the handoff', async () => {
  vi.useFakeTimers();
  const host = bridge();
  host.state.draft = '  A draft\nwith spacing  ';
  mountStartup(host);
  expect(document.querySelector('textarea, .startup-search')).toBeNull();
  document.getElementById('startup-tab-tour')!.click();
  await vi.advanceTimersByTimeAsync(120);
  const accept = vi.fn(async () => {});
  window.__GEZEL_STARTUP__!.connect(accept);
  await vi.runAllTimersAsync();
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({
      tab: 'tour',
      article: 0,
      draft: host.state.draft,
      focused: false,
    }),
  );
  expect(host.finish).toHaveBeenCalledWith(host.state.draft);
  expect(document.getElementById('startup-home')).toBeNull();
});

it('hands over the saved reading position while the remounted reader is still loading', async () => {
  vi.useFakeTimers();
  const host = bridge();
  host.state.tab = 'tour';
  host.state.scroll = 240;
  mountStartup(host);
  const accept = vi.fn(async () => {});
  window.__GEZEL_STARTUP__!.connect(accept);
  expect(accept).toHaveBeenCalledWith(expect.objectContaining({ tab: 'tour', scroll: 240 }));
  expect(host.save).toHaveBeenCalledWith(expect.objectContaining({ scroll: 240 }));
  await vi.runAllTimersAsync();
});

it('records where the person scrolled the reader', () => {
  mountStartup(bridge());
  const reading = document.getElementById('startup-reading')!;
  Object.defineProperty(reading, 'scrollTop', { configurable: true, value: 90 });
  reading.dispatchEvent(new Event('scroll'));
  expect(window.__GEZEL_STARTUP__!.state().scroll).toBe(90);
});

it('keeps the reader and draft usable if saving to the live app fails', async () => {
  const host = bridge();
  host.state.draft = 'Do not lose this';
  mountStartup(host);
  window.__GEZEL_STARTUP__!.connect(async () => {
    throw new Error('offline');
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(document.getElementById('startup-home')!.inert).toBe(false);
  expect(window.__GEZEL_STARTUP__!.state().draft).toBe('Do not lose this');
  expect(host.finish).not.toHaveBeenCalled();
});

describe('the sheet rail', () => {
  const rail = () => document.querySelector<HTMLButtonElement>('.home-workshop-sheet-rail')!;
  const band = () => document.querySelector<HTMLElement>('.home-workshop-greeting')!;
  const sheet = () => document.querySelector<HTMLElement>('.home-workshop-intro-sheet')!;
  const rolledUp = () => band().classList.contains('home-workshop-greeting-collapsed');

  it('rolls the sheet up, and a tab opens it again on that tab', () => {
    const host = bridge();
    mountStartup(host);
    rail().click();
    expect(rolledUp()).toBe(true);
    expect(sheet().inert).toBe(true);
    expect(window.__GEZEL_STARTUP__!.state().tab).toBe('chat');
    expect(host.save).toHaveBeenLastCalledWith(expect.objectContaining({ tab: 'chat' }));

    document.getElementById('startup-tab-tour')!.click();
    expect(rolledUp()).toBe(false);
    expect(sheet().inert).toBe(false);
    expect(window.__GEZEL_STARTUP__!.state().tab).toBe('tour');
    expect(document.getElementById('startup-tab-tour')).toHaveAttribute('aria-expanded', 'true');
  });

  it('rolls up when the open tab is chosen again', () => {
    mountStartup(bridge());
    const greeting = document.getElementById('startup-tab-greeting')!;
    greeting.click();
    expect(rolledUp()).toBe(true);
    expect(greeting).toHaveAttribute('aria-expanded', 'false');
    greeting.click();
    expect(rolledUp()).toBe(false);
    expect(window.__GEZEL_STARTUP__!.state().tab).toBe('greeting');
  });

  it('hands a rolled-up sheet to the live Home as the conversation', async () => {
    vi.useFakeTimers();
    mountStartup(bridge());
    rail().click();
    const accept = vi.fn(async () => {});
    window.__GEZEL_STARTUP__!.connect(accept);
    await vi.runAllTimersAsync();
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ tab: 'chat' }));
  });

  function pull(lift: number, end: 'pointerUp' | 'pointerCancel' = 'pointerUp') {
    mountStartup(bridge());
    sheet().getBoundingClientRect = () => ({ height: 400 }) as DOMRect;
    fireEvent.pointerDown(rail(), { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(rail(), { pointerId: 1, clientY: 500 - lift / 2 });
    const midway = sheet().style.height;
    const dragging = sheet().hasAttribute('data-dragging');
    fireEvent.pointerMove(rail(), { pointerId: 1, clientY: 500 - lift });
    fireEvent[end](rail(), { pointerId: 1, clientY: 500 - lift });
    fireEvent.click(rail());
    return { midway, dragging };
  }

  it('follows the pointer, then rolls up when let go past a quarter of the sheet', () => {
    const { midway, dragging } = pull(120);
    expect(midway).toBe('340px');
    expect(dragging).toBe(true);
    expect(rolledUp()).toBe(true);
    expect(sheet().style.height).toBe('');
    expect(sheet().hasAttribute('data-dragging')).toBe(false);
  });

  it('drops back open when let go short of it, without the click rolling it up', () => {
    pull(80);
    expect(rolledUp()).toBe(false);
    expect(sheet().style.height).toBe('');
  });

  it('drops back open when the pointer is taken away', () => {
    pull(200, 'pointerCancel');
    expect(rolledUp()).toBe(false);
  });
});

// The start screen showed a brand, a status pill and one Home row, then the
// live bar and rail arrived with six more keys and rows (2026-11-09 review).
describe('the frame it draws', () => {
  it('holds the places of the live title bar and navigation', () => {
    mountStartup(bridge());
    const header = document.querySelector('.startup-header')!;
    expect(header.querySelectorAll('.app-history-key')).toHaveLength(3);
    for (const key of header.querySelectorAll<HTMLButtonElement>('.app-history-key')) {
      expect(key.disabled).toBe(true);
    }
    expect(header.querySelector('.app-header-brand')).not.toBeNull();
    expect(header.querySelector<HTMLInputElement>('.titlebar-search-input')?.disabled).toBe(true);
    const rail = document.querySelector('.startup-sidebar')!;
    expect(
      [...rail.querySelectorAll('.app-sidebar-item-label')].map((label) => label.textContent),
    ).toEqual(['Home ', 'Projects', 'Documents', 'Crew', 'Workshop', 'Knowledge', 'Settings']);
    expect(rail.querySelector('.startup-navigation-rest')?.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('.startup-loading-line')).toHaveTextContent(
      'Opening your workshop',
    );
    expect(document.querySelector('.startup-composer')).not.toBeNull();
  });

  it('shows the live tabs: Night shift only with a night to read about, and Create', () => {
    mountStartup(bridge());
    const tabs = () =>
      [...document.querySelectorAll('.home-workshop-tab')].map((tab) => tab.textContent);
    expect(tabs().slice(1)).toEqual(['Create', 'Handboek']);
    document.body.replaceChildren();
    const host = bridge();
    host.snapshot = {
      version: 1,
      savedAt: '2026-11-10T08:00:00Z',
      meester: { id: 'vanya', name: 'Vanya' },
      theme: 'system',
      sidebar: 'right',
      status: null,
      lastMessage: null,
      night: { windowEnd: '2026-11-10T06:00:00Z', completed: 2, reports: [] },
    };
    mountStartup(host);
    expect(tabs().slice(1)).toEqual(['Night shift', 'Create', 'Handboek']);
  });

  it('draws the welcome for a home nobody has used yet, with no greeting sheet', () => {
    const host = bridge();
    host.snapshot = {
      version: 1,
      savedAt: '2026-11-10T08:00:00Z',
      meester: { id: 'vanya', name: 'Vanya' },
      welcome: true,
      theme: 'system',
      sidebar: 'right',
      status: null,
      lastMessage: null,
      night: null,
    };
    mountStartup(host);
    expect(document.getElementById('startup-home')?.dataset.shape).toBe('welcome');
    expect(document.querySelector<HTMLElement>('.home-workshop-greeting')?.hidden).toBe(true);
    expect(document.querySelector('.startup-welcome .meester-welcome-title')).toHaveTextContent(
      "I'm Vanya — I run this workshop.",
    );
  });
});
