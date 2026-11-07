import type { ReactNode } from 'react';

export interface PersonLabelProps {
  /** Already resolved for display (`displayName`), so the names switch is honored. */
  name: string;
  /**
   * The role in plain English: pass a stored role through `plainRoleTitle`.
   * Omit it when the name already is the role. Not `role`, which JSX reads
   * as an ARIA role.
   */
  roleTitle?: string | null;
  /** `inline`: "Ada Lovelace · Engineer" on one line. `stacked`: name above role. */
  variant?: 'inline' | 'stacked';
  /**
   * A leading face, usually a `GezelIcon`, which honors the poppetjes switch
   * on its own. Leave it out where a surface hides faces with poppetjes off.
   */
  face?: ReactNode;
  /** A mark that belongs to the person (the Meester's hat), set right after the name. */
  badge?: ReactNode;
  /**
   * Sizes it: an inline label inherits its font size; a stacked one reads
   * `--person-label-name-size` and `--person-label-role-size`.
   */
  className?: string;
  title?: string;
}

/**
 * The one way to write a crew member and their role. Every surface that
 * names a person and what they do renders this, so the pairing never drifts
 * back into uppercase names, parentheses, hyphens or arrows.
 *
 * It imports nothing but React on purpose: the startup screen draws the
 * Meester's caption with it, and that script must stay small.
 */
export function PersonLabel({
  name,
  roleTitle,
  variant = 'inline',
  face,
  badge,
  className,
  title,
}: PersonLabelProps) {
  const roleText = roleTitle?.trim();
  const classes = ['person-label', `person-label--${variant}`, className].filter(Boolean).join(' ');
  const faceNode = face ? (
    <span className="person-label-face" aria-hidden="true">
      {face}
    </span>
  ) : null;
  const nameNode = <span className="person-label-name">{name}</span>;
  const roleNode = roleText ? <span className="person-label-role">{roleText}</span> : null;

  // The spaces between parts are for copied text and accessible names
  // ("Ada Lovelace · Engineer"); a flex container does not render them.
  if (variant === 'stacked') {
    return (
      <span className={classes} title={title}>
        {faceNode}
        <span className="person-label-text">
          <span className="person-label-name-line">
            {nameNode}
            {badge && <> {badge}</>}
          </span>
          {roleNode && <> {roleNode}</>}
        </span>
      </span>
    );
  }

  return (
    <span className={classes} title={title}>
      {faceNode}
      {nameNode}
      {badge && <> {badge}</>}
      {roleNode && (
        <>
          {' '}
          <span className="person-label-sep">·</span> {roleNode}
        </>
      )}
    </span>
  );
}
