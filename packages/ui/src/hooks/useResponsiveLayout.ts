import { useCallback, useEffect, useState } from 'react';

export const MOBILE_LAYOUT_QUERY = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';

function isMobilePreview(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('layout') === 'mobile'
  );
}

/** The same breakpoint drives native shells and the desktop preview of the actual app. */
export function useResponsiveLayout() {
  const [preview, setPreview] = useState(isMobilePreview);
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches === true,
  );
  const compact = preview || narrow;

  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_LAYOUT_QUERY);
    if (!query) return;
    const changed = () => setNarrow(query.matches);
    changed();
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const changed = () => setPreview(isMobilePreview());
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);

  useEffect(() => {
    if (!compact) {
      delete document.documentElement.dataset.layout;
      return;
    }
    // Desktop only pays for the compact stylesheet when it narrows, but the
    // attribute must not land first: styling the tree as mobile before its
    // rules arrive shows a frame of unstyled compact layout. The native host
    // imports the sheet eagerly, so there it resolves immediately.
    let cancelled = false;
    void import('../components/ResponsiveAppShell.mobile.css').then(() => {
      if (!cancelled) document.documentElement.dataset.layout = 'mobile';
    });
    return () => {
      cancelled = true;
      delete document.documentElement.dataset.layout;
    };
  }, [compact]);

  const exitPreview = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('layout');
    window.history.replaceState(window.history.state, '', url);
    setPreview(false);
  }, []);

  return { compact, preview, exitPreview };
}
