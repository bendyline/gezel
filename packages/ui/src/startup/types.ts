import type { StartupHomeSnapshot, StartupHomeView } from '@bendyline/gezel';

export interface StartupHomeBridge {
  active: boolean;
  snapshot: StartupHomeSnapshot | null;
  state: StartupHomeView;
  save(state: StartupHomeView): boolean;
  finish(draft: string): boolean;
}

export interface StartupHomeSurface {
  state(): StartupHomeView;
  reading(): HTMLElement;
  /** Freezes only during the final draft save; failure leaves the reader usable. */
  connect(accept: (view: StartupHomeView) => Promise<void>): void;
}

declare global {
  interface Window {
    __GEZEL_STARTUP__?: StartupHomeSurface;
  }
}
