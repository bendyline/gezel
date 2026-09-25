(() => {
  // Native hosts inject this before authored JavaScript in EVERY frame. An
  // iframe created later (including srcdoc/about:blank) must not regain APIs
  // whose networking is outside CSP. Only the packaged main document is trusted.
  const packaged =
    window === window.top &&
    ((location.protocol === 'https:' && location.hostname === 'localhost') ||
      (location.protocol === 'capacitor:' && location.hostname === 'localhost')) &&
    ['', '/', '/index.html'].includes(location.pathname);
  if (packaged) return;
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name.startsWith('RTC') || name === 'webkitRTCPeerConnection') {
      try {
        Object.defineProperty(window, name, {
          value: undefined,
          writable: false,
          configurable: false,
        });
      } catch {}
    }
  }
  for (const value of [window.URL, window.webkitURL]) {
    if (value)
      try {
        Object.defineProperty(value, 'createObjectURL', {
          value: undefined,
          writable: false,
          configurable: false,
        });
      } catch {}
  }
})();
