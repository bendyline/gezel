import { useEffect } from 'react';

/** The native Back gesture follows the same overlay dismissal and navigation
 * state as the visible controls. Hidden panes remain mounted with their drafts. */
export function useBackNavigation(
  compact: boolean,
  navigationOpen: boolean,
  openNavigation: () => void,
): void {
  useEffect(() => {
    const back = (event: Event) => {
      const overlay = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]',
        ),
      ].find(
        (element) =>
          !element.closest('[hidden], [inert], [data-state="closed"]') &&
          getComputedStyle(element).display !== 'none',
      );
      if (overlay) {
        event.preventDefault();
        (document.activeElement ?? document).dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      } else if (compact && !navigationOpen) {
        event.preventDefault();
        openNavigation();
      }
    };
    window.addEventListener('gezel:back', back);
    return () => window.removeEventListener('gezel:back', back);
  }, [compact, navigationOpen, openNavigation]);
}
