import { afterEach, expect, it, vi } from 'vitest';
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
