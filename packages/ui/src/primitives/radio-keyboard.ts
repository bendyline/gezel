import type { KeyboardEvent } from 'react';

/** Keyboard behavior shared by the button-shaped radio keys. */
export function onRadioKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
    return;
  const group = event.currentTarget;
  const target = event.target instanceof Element ? event.target.closest('[role="radio"]') : null;
  if (!target || target.closest('[role="radiogroup"]') !== group) return;
  const items = Array.from(
    group.querySelectorAll<HTMLButtonElement>('button[role="radio"]'),
  ).filter(
    (item) =>
      !item.disabled &&
      item.getAttribute('aria-disabled') !== 'true' &&
      item.closest('[role="radiogroup"]') === group,
  );
  const index = items.indexOf(target as HTMLButtonElement);
  if (index < 0 || items.length === 0) return;
  event.preventDefault();
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else {
    const rtl = getComputedStyle(group).direction === 'rtl';
    const backwards = event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    next = (index + (backwards ? -1 : 1) + items.length) % items.length;
  }
  items[next]?.focus();
  items[next]?.click();
}
