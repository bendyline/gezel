import { useState } from 'react';
import { type SidebarSide, getSidebarSide, setSidebarSide } from '../sidebar-side.js';
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
  const [side, setSide] = useState<SidebarSide>(getSidebarSide);
  return (
    <div className="provider-switch">
      {(['left', 'right'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={side === value}
          className={`provider-pill${side === value ? ' provider-pill-active' : ''}`}
          onClick={() => {
            setSidebarSide(value);
            setSide(value);
          }}
        >
          {value === 'left' ? 'Left' : 'Right'}
        </button>
      ))}
    </div>
  );
}
