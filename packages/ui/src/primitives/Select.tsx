import * as RadixSelect from '@radix-ui/react-select';
import type { CSSProperties, ReactNode } from 'react';

export const Root = RadixSelect.Root;
export const Value = RadixSelect.Value;
export const Portal = RadixSelect.Portal;
export const Group = RadixSelect.Group;
export const Label = RadixSelect.Label;
export const Separator = RadixSelect.Separator;

/** The trigger's down-caret, as a true equilateral triangle.
 *  The Unicode glyph this replaces (▾ U+25BE) renders squat and
 *  baseline-offset in most UI fonts, so the caret read as lopsided next
 *  to a square-cornered trigger. Side 10, height 10·√3/2 ≈ 8.66, centred
 *  in a 12×12 box — same reasoning as the greeting band's Chevron. */
function Caret() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
      <polygon points="1,1.67 11,1.67 6,10.33" />
    </svg>
  );
}

export function Trigger(props: RadixSelect.SelectTriggerProps) {
  const { className, children, ...rest } = props;
  return (
    <RadixSelect.Trigger
      {...rest}
      className={className ? `gz-select-trigger ${className}` : 'gz-select-trigger'}
    >
      {children}
      <RadixSelect.Icon className="gz-select-icon" aria-hidden>
        <Caret />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

export function Content(props: RadixSelect.SelectContentProps) {
  const { className, children, position = 'popper', sideOffset = 4, ...rest } = props;
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        {...rest}
        position={position}
        sideOffset={sideOffset}
        className={className ? `gz-select-content ${className}` : 'gz-select-content'}
      >
        <RadixSelect.Viewport className="gz-select-viewport">{children}</RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

export function Item({
  value,
  children,
  disabled,
  style,
  textValue,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
  /** Optional inline style for the item — used by the font picker to
   *  render each option in the font it represents. */
  style?: CSSProperties;
  /** Plain-text label for typeahead + the trigger's accessible value
   *  when `children` is rich JSX (e.g. mention pills). */
  textValue?: string;
}) {
  return (
    <RadixSelect.Item
      value={value}
      disabled={disabled}
      className="gz-select-item"
      style={style}
      textValue={textValue}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
}
