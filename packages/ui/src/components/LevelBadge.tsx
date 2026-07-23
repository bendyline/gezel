/**
 * Level chip for a gezel — plain HTML/CSS (no poppetje dependency) so it
 * overlays poppetjes, legacy SVG sigils, and letter-fallback avatars
 * alike, and survives the poppetje off-switch. Renders nothing below
 * level 2 unless a level-up is pending: level 1 is the unremarkable
 * default, not an achievement.
 */

interface LevelBadgeProps {
  level: number;
  /** A level-up is waiting for the user's choice — shows the dot. */
  pending?: boolean;
  /** Absolute-position over the bottom-right of an avatar (anchor must be position:relative). */
  overlay?: boolean;
}

export function LevelBadge({ level, pending = false, overlay = false }: LevelBadgeProps) {
  if (level < 2 && !pending) return null;
  const title = pending
    ? `Level ${level} — a level-up is waiting in the Growth tab`
    : `Level ${level}`;
  return (
    <span
      className={`level-badge${overlay ? ' level-badge--overlay' : ''}`}
      title={title}
      aria-label={title}
    >
      Lv {level}
      {pending && <span className="level-badge-dot" aria-hidden="true" />}
    </span>
  );
}
