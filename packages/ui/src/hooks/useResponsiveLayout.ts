import { useCallback, useEffect, useState } from 'react';

export const MOBILE_LAYOUT_QUERY = '(max-width: 760px)';

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
    if (compact) {
      document.documentElement.dataset.layout = 'mobile';
      void import('../components/ResponsiveAppShell.mobile.css');
    } else delete document.documentElement.dataset.layout;
    return () => {
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
