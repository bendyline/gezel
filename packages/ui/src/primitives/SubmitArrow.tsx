import type { SVGProps } from 'react';

/**
 * The shared submit glyph for a composer's primary action — chat's Send and
 * the terminal's Fire. Both buttons say "this draft goes now", so they carry
 * one mark rather than two words that would have to be kept in step. Keep it
 * distinct from `DropdownChevron`: that one reveals a list, this one commits.
 */
export function SubmitArrow({ className, ...props }: Omit<SVGProps<SVGSVGElement>, 'children'>) {
  return (
    <svg
      {...props}
      className={className ? `gz-submit-arrow ${className}` : 'gz-submit-arrow'}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 13V3.75M8 3.25 3.75 7.5M8 3.25 12.25 7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
