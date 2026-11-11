import { useState, useSyncExternalStore } from 'react';
import { getSidebarSide, onSidebarSideChange, setSidebarSide } from '../sidebar-side.js';
import { type ThemePref, getThemePref, setThemePref } from '../theme.js';

export function ThemePicker() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  return (
    <div className="provider-switch">
      {(['system', 'light', 'dark'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={pref === value}
          className={`provider-pill${pref === value ? ' provider-pill-active' : ''}`}
          onClick={() => {
            setThemePref(value);
            setPref(value);
          }}
        >
          {value === 'system' ? 'Follow system' : value === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

export function SidebarSidePicker() {
  // Followed, not read once: the boot-time sync can settle the side after
  // this has drawn, and the key that is down must be the side the rail is on.
  const side = useSyncExternalStore(onSidebarSideChange, getSidebarSide);
  return (
    <div className="provider-switch">
      {(['left', 'right'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={side === value}
          className={`provider-pill${side === value ? ' provider-pill-active' : ''}`}
          onClick={() => setSidebarSide(value)}
        >
          {value === 'left' ? 'Left' : 'Right'}
        </button>
      ))}
    </div>
  );
}
