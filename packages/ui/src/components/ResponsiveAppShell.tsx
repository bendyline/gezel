import { type ReactNode, useEffect, useRef } from 'react';
import './ResponsiveAppShell.css';

export interface ResponsiveAppShellProps {
  compact: boolean;
  navigationOpen: boolean;
  navigation: ReactNode;
  children: ReactNode;
  mainClassName?: string;
  navigationLabel?: string;
  /**
   * The destination on screen, as `data-view` on the shell (`home`, `project`…),
   * for styles that depend on it. A `:has()` on a node this high is re-checked
   * on every insertion below it: `.app-body:has(.home-workshop)` restyled the
   * whole app on each frame of a streaming reply.
   */
  view?: string;
}

/** Both panes stay mounted so opening navigation does not discard a chat draft or editor. */
export function ResponsiveAppShell({
  compact,
  navigationOpen,
  navigation,
  children,
  mainClassName = '',
  navigationLabel = 'Navigation',
  view,
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
    <div className="app-body responsive-app-shell" data-compact={compact} data-view={view}>
      <div
        ref={navigationRef}
        className="responsive-app-navigation"
        data-layout-frame="rail"
        hidden={compact && !navigationOpen}
        aria-label={navigationLabel}
      >
        {navigation}
      </div>
      <main
        ref={mainRef}
        className={`app-main ${mainClassName}`.trim()}
        data-layout-frame="pane"
        hidden={compact && navigationOpen}
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}
