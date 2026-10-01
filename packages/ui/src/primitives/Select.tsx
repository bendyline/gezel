import * as RadixSelect from '@radix-ui/react-select';
import { type CSSProperties, type FocusEvent, type ReactNode, useCallback, useRef } from 'react';
import { DropdownChevron } from './DropdownChevron.js';
import { appCollisionBoundary } from './appCollisionBoundary.js';

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

export function Content(
  props: RadixSelect.SelectContentProps & {
    /**
     * Open on the first row rather than the selected one. Radix scrolls the
     * selection into view and hides the viewport's scrollbar, so in a short
     * panel (a phone with the keyboard up) the rows above it vanish without a
     * trace. For menus that lead with actions, like the thread picker's
     * New thread.
     */
    openAtTop?: boolean;
  },
) {
  const {
    className,
    children,
    position = 'popper',
    sideOffset = 4,
    openAtTop = false,
    ...rest
  } = props;
  // Only the focus Radix gives the selected row on open may move the list.
  // Anything the person focuses first ends it, so a row never jumps away
  // from a finger that is already on it.
  const settledRef = useRef(false);
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    if (node) settledRef.current = false;
  }, []);
  const onViewportFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (!(event.target as HTMLElement).matches('[data-state="checked"]')) return;
    const viewport = event.currentTarget;
    // After the browser's own scroll-into-view for that focus.
    requestAnimationFrame(() => {
      viewport.scrollTop = 0;
    });
  }, []);
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        {...rest}
        position={position}
        collisionBoundary={rest.collisionBoundary ?? appCollisionBoundary()}
        sideOffset={sideOffset}
        className={className ? `gz-select-content ${className}` : 'gz-select-content'}
      >
        <RadixSelect.Viewport
          className="gz-select-viewport"
          {...(openAtTop ? { ref: viewportRef, onFocus: onViewportFocus } : {})}
        >
          {children}
        </RadixSelect.Viewport>
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
