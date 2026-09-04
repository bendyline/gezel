import * as RadixSelect from '@radix-ui/react-select';
import type { CSSProperties, ReactNode } from 'react';
import { DropdownChevron } from './DropdownChevron.js';

export const Root = RadixSelect.Root;
export const Value = RadixSelect.Value;
export const Portal = RadixSelect.Portal;
export const Group = RadixSelect.Group;

export function Label(props: RadixSelect.SelectLabelProps) {
  const { className, ...rest } = props;
  return (
    <RadixSelect.Label
      {...rest}
      className={className ? `gz-select-label ${className}` : 'gz-select-label'}
    />
  );
}

export function Separator(props: RadixSelect.SelectSeparatorProps) {
  const { className, ...rest } = props;
  return (
    <RadixSelect.Separator
      {...rest}
      className={className ? `gz-select-separator ${className}` : 'gz-select-separator'}
    />
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
        <DropdownChevron />
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
  trailing,
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
  /**
   * Row-scoped content rendered OUTSIDE `ItemText` — a per-row action, say.
   * The distinction matters: Radix portals an item's `ItemText` into the
   * trigger when that item is the selected one, so anything placed there
   * shows up twice, and an interactive control would land inside the
   * trigger's own button.
   */
  trailing?: ReactNode;
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
      {trailing}
    </RadixSelect.Item>
  );
}
