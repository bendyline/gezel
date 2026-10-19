import { afterEach, expect, it, vi } from 'vitest';
import { appendReading } from './reader.js';
import { mountStartup } from './screen.js';
import type { StartupHomeBridge } from './types.js';

const articles = [
  { id: 'welcome', markdown: '# Welcome\n\nA local introduction.' },
  { id: 'crew', markdown: '# Your crew\n\nYour companions.' },
];
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

it('offers keyboard navigation and carries reading selection and exact typing into the handoff', async () => {
  vi.useFakeTimers();
  const host = bridge();
  mountStartup(host, articles);
  document.getElementById('startup-tab-tour')!.click();
  const picker = document.querySelectorAll<HTMLButtonElement>('.startup-article-picker button');
  picker[1]!.click();
  const input = document.querySelector('textarea')!;
  input.value = '  A draft\nwith spacing  ';
  input.focus();
  input.setSelectionRange(3, 8);
  input.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(120);
  const accept = vi.fn(async () => {});
  window.__GEZEL_STARTUP__!.connect(accept);
  await vi.runAllTimersAsync();
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({
      tab: 'tour',
      article: 1,
      draft: input.value,
      focused: true,
      selectionStart: 3,
      selectionEnd: 8,
    }),
  );
  expect(host.finish).toHaveBeenCalledWith(input.value);
  expect(document.getElementById('startup-home')).toBeNull();
});

it('keeps the reader and draft usable if saving to the live app fails', async () => {
  const host = bridge();
  mountStartup(host, articles);
  const input = document.querySelector('textarea')!;
  input.value = 'Do not lose this';
  window.__GEZEL_STARTUP__!.connect(async () => {
    throw new Error('offline');
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(document.getElementById('startup-home')!.inert).toBe(false);
  expect(input.value).toBe('Do not lose this');
  expect(host.finish).not.toHaveBeenCalled();
});

it('renders saved markup as inert text and omits executable report actions', () => {
  const node = document.createElement('section');
  appendReading(
    node,
    '# Report\n\n<script>steal()</script>\n\n[x](javascript:steal())\n\n```gezel-action\n{"command":"run"}\n```',
  );
  expect(node.querySelector('script, a, iframe, img')).toBeNull();
  expect(node.textContent).toContain('Report');
  expect(node.textContent).not.toContain('"command"');
});
