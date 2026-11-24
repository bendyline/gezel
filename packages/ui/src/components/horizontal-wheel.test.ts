import { afterEach, describe, expect, it } from 'vitest';
import { attachHorizontalWheel } from './horizontal-wheel.js';

function strip(scrollWidth: number, clientWidth: number): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
  document.body.appendChild(el);
  return el;
}

function wheel(target: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('attachHorizontalWheel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('turns a vertical wheel into horizontal scrolling', () => {
    const el = strip(1000, 400);
    const detach = attachHorizontalWheel(el);
    const down = wheel(el, { deltaY: 120 });
    expect(el.scrollLeft).toBe(120);
    expect(down.defaultPrevented).toBe(true);
    wheel(el, { deltaY: -50 });
    expect(el.scrollLeft).toBe(70);
    detach();
  });

  it('leaves the wheel to the page at either end of the strip', () => {
    const el = strip(1000, 400);
    const detach = attachHorizontalWheel(el);
    expect(wheel(el, { deltaY: -100 }).defaultPrevented).toBe(false);
    el.scrollLeft = 600;
    expect(wheel(el, { deltaY: 100 }).defaultPrevented).toBe(false);
    detach();
  });

  it('does nothing when the strip does not overflow, or for Ctrl+wheel zoom', () => {
    const fits = strip(400, 400);
    const detachFits = attachHorizontalWheel(fits);
    expect(wheel(fits, { deltaY: 100 }).defaultPrevented).toBe(false);
    detachFits();

    const el = strip(1000, 400);
    const detach = attachHorizontalWheel(el);
    expect(wheel(el, { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(el.scrollLeft).toBe(0);
    detach();
  });

  it('stops listening once detached', () => {
    const el = strip(1000, 400);
    attachHorizontalWheel(el)();
    wheel(el, { deltaY: 100 });
    expect(el.scrollLeft).toBe(0);
  });
});
