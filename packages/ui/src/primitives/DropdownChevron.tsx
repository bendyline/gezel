import type { SVGProps } from 'react';

/**
 * The shared open-V indicator for controls that reveal a list of choices.
 * Keep disclosure arrows and directional controls separate: this icon is
 * specifically the visual vocabulary for dropdowns, selects, and pickers.
 */
export function DropdownChevron({
  className,
  ...props
}: Omit<SVGProps<SVGSVGElement>, 'children'>) {
  return (
    <svg
      {...props}
      className={className ? `gz-dropdown-chevron ${className}` : 'gz-dropdown-chevron'}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m2.25 4.25 3.75 3.5 3.75-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
