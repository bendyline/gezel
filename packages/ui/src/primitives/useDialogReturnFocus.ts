import { useRef } from 'react';

/** Controlled dialogs may have no Trigger, or navigate away from their launcher. */
export function useDialogReturnFocus(
  onOpenAutoFocus?: (event: Event) => void,
  onCloseAutoFocus?: (event: Event) => void,
) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event: Event) {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const previous = returnFocus.current;
      const destination =
        previous &&
        previous !== document.body &&
        previous.isConnected &&
        !previous.closest('[hidden], [inert]') &&
        getComputedStyle(previous).display !== 'none'
          ? previous
          : document.querySelector<HTMLElement>('main:not([hidden])[tabindex]');
      if (destination) {
        event.preventDefault();
        destination.focus();
      }
    },
  };
}
