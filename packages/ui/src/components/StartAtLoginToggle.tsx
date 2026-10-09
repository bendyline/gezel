import { useEffect, useState } from 'react';

/**
 * "Start Gezel when I log in", for the packaged desktop app. Renders nothing
 * where the shell can't register a login item (the web UI, dev builds).
 */
export function StartAtLoginToggle({ style }: { style?: React.CSSProperties }) {
  const bridge = window.__GEZEL__?.startAtLogin;
  const [state, setState] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge
      ?.get()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge || !state?.supported) return null;
  return (
    <label style={style}>
      <input
        type="checkbox"
        checked={state.enabled}
        disabled={busy}
        onChange={(e) => {
          setBusy(true);
          void bridge
            .set(e.target.checked)
            .then(setState)
            .catch(() => {})
            .finally(() => setBusy(false));
        }}
      />
      <span>Start Gezel when I log in, without opening a window</span>
    </label>
  );
}
