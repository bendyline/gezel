import { type ReactNode, useEffect, useRef } from 'react';
import './ResponsiveAppShell.css';

export interface ResponsiveAppShellProps {
  compact: boolean;
  navigationOpen: boolean;
  navigation: ReactNode;
  children: ReactNode;
  mainClassName?: string;
  navigationLabel?: string;
}

/** Both panes stay mounted so opening navigation does not discard a chat draft or editor. */
export function ResponsiveAppShell({
  compact,
  navigationOpen,
  navigation,
  children,
  mainClassName = '',
  navigationLabel = 'Navigation',
}: ResponsiveAppShellProps) {
  const navigationRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousPane = useRef(navigationOpen);

  useEffect(() => {
    if (compact && previousPane.current !== navigationOpen) {
      if (navigationOpen) {
        navigationRef.current?.querySelector<HTMLElement>('button, a, input')?.focus();
      } else {
        mainRef.current?.focus();
      }
    }
    previousPane.current = navigationOpen;
  }, [compact, navigationOpen]);

  return (
    <div className="app-body responsive-app-shell" data-compact={compact}>
      <div
        ref={navigationRef}
        className="responsive-app-navigation"
        hidden={compact && !navigationOpen}
        aria-label={navigationLabel}
      >
        {navigation}
      </div>
      <main
        ref={mainRef}
        className={`app-main ${mainClassName}`.trim()}
        hidden={compact && navigationOpen}
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}
