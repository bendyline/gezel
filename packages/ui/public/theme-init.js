/* Apply the persisted theme before the bundle loads so the first paint
   matches the user's choice — no flash of the opposite theme.

   Kept as an EXTERNAL classic script (not inline) so the renderer's
   Content-Security-Policy can use a strict `script-src 'self'` with no
   'unsafe-inline'. Loaded from <head> so it runs before first paint. */
(() => {
  try {
    const pref = localStorage.getItem('gezel:theme');
    if (pref === 'light' || pref === 'dark') {
      document.documentElement.setAttribute('data-theme', pref);
    }
  } catch (_) {}
  // Sidebar side, same rationale: apply the cached choice before the
  // bundle mounts React so the nav rail renders on the correct side with
  // no side-to-side jump. RIGHT is the default, so anything other than an
  // explicit 'left' resolves to right and stamps the attribute; 'left' is
  // the CSS base (no attribute).
  try {
    if (localStorage.getItem('gezel:sidebar-side') !== 'left') {
      document.documentElement.setAttribute('data-sidebar-side', 'right');
    }
  } catch (_) {}
})();
