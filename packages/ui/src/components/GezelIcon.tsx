import type { Poppetje as PoppetjeStruct } from '@bendyline/gezel';
import type { MouseEventHandler } from 'react';
import { Poppetje, type PoppetjeVariant } from '../poppetje/index.js';
import { useShowPoppetjes } from './useShowPoppetjes.js';

interface GezelIconProps {
  /**
   * Legacy LLM-generated abstract sigil. When `iconOverride` is true
   * and this is present, it's rendered instead of the poppetje. Always
   * shown on its own when `poppetje` is missing (e.g. mid-generation
   * fallback for older gezels).
   */
  svg?: string | null;
  /** The gezel's persisted character figure data. Preferred over `svg`. */
  poppetje?: PoppetjeStruct | null;
  /**
   * When true and `svg` is present, render the abstract icon instead of
   * the poppetje. Per-gezel toggle from Gezel Detail.
   */
  iconOverride?: boolean;
  name: string;
  size?: number;
  pulsing?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement | HTMLDivElement>;
  title?: string;
  /**
   * Force a specific poppetje variant. When unset, derives from `size`:
   * head-only for ≤64px, headshot for medium, full for the gezel-detail
   * hero (caller passes 'full' explicitly there).
   */
  variant?: PoppetjeVariant;
}

// Derive a stable hue from the name so fallback avatars look distinct per gezel.
function hueFromName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function variantForSize(size: number): PoppetjeVariant {
  if (size <= 64) return 'icon';
  if (size <= 120) return 'headshot';
  return 'full';
}

export function GezelIcon({
  svg,
  poppetje,
  iconOverride,
  name,
  size = 28,
  pulsing = false,
  onClick,
  title,
  variant,
}: GezelIconProps) {
  const showPoppetjes = useShowPoppetjes();
  const style = { width: size, height: size };
  const classes = [
    'gezel-icon',
    onClick ? 'gezel-icon--clickable' : '',
    pulsing ? 'gezel-icon--pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Decision tree: opt-in icon override beats poppetje; poppetje beats
  // letter avatar. The letter avatar is the safety net while the first
  // poppetje read is racing back (it shouldn't normally render — the
  // service inlines the poppetje in the listGezels response).
  const showLegacyIcon = iconOverride && !!svg;
  // When the user turns poppetjes off (config.showPoppetjes), skip the
  // poppetje branch so we fall through to the legacy sigil or the letter
  // avatar — the same fallbacks used when a gezel has no poppetje.
  const content = showLegacyIcon ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized upstream
    <div className="gezel-icon-svg" dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
  ) : poppetje && showPoppetjes ? (
    <div className="gezel-icon-poppetje">
      <Poppetje
        poppetje={poppetje}
        variant={variant ?? variantForSize(size)}
        size={size}
        title={title ?? `${name} poppetje`}
      />
    </div>
  ) : svg ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized upstream
    <div className="gezel-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <FallbackAvatar name={name} />
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        style={style}
        onClick={onClick}
        title={title}
        aria-label={title ?? `${name} icon`}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={classes} style={style} title={title}>
      {content}
    </div>
  );
}

function FallbackAvatar({ name }: { name: string }) {
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  const hue = hueFromName(name);
  const bg = `hsl(${hue}, 55%, 45%)`;
  return (
    <div className="gezel-icon-fallback" style={{ background: bg }}>
      {letter}
    </div>
  );
}
