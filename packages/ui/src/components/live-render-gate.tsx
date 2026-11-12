import { type ReactNode, createContext, useContext } from 'react';

/**
 * Whether streamed content below this point is on screen. A closed working
 * notes fold or a hidden phone pane says no, and live items under it stop
 * redrawing on every frame (each redraw re-parses the reply's markdown),
 * then catch up in one render when shown. Nested gates combine: content is
 * shown only when every gate above it is open.
 */
const LiveRenderGateContext = createContext(true);

export function LiveRenderGate({ shown, children }: { shown: boolean; children: ReactNode }) {
  const above = useContext(LiveRenderGateContext);
  return (
    <LiveRenderGateContext.Provider value={above && shown}>
      {children}
    </LiveRenderGateContext.Provider>
  );
}

export function useLiveContentShown(): boolean {
  return useContext(LiveRenderGateContext);
}
