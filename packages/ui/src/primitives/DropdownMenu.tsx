import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { appCollisionBoundary } from './appCollisionBoundary.js';

// Keep Radix behind the shared primitives barrel so menu behavior and
// animation remain one edit away from a global change.
export const Root = RadixDropdownMenu.Root;
export const Trigger = RadixDropdownMenu.Trigger;

/**
 * An inert anchor for a menu something else opens. Radix needs a Trigger to
 * position against, but composing one onto a control that has its own Radix
 * state (a tab) overwrites that control's `data-state`. Render this inside
 * the control and drive `Root`'s `open` yourself: the span takes no pointer
 * events and no focus, so the control keeps every interaction.
 */
export function AnchorTrigger({ className }: { className?: string }) {
  return (
    <RadixDropdownMenu.Trigger asChild>
      <span
        aria-hidden="true"
        tabIndex={-1}
        className={className ? `gz-menu-anchor ${className}` : 'gz-menu-anchor'}
      />
    </RadixDropdownMenu.Trigger>
  );
}
export const Portal = RadixDropdownMenu.Portal;
export function Content(props: ComponentProps<typeof RadixDropdownMenu.Content>) {
  return (
    <RadixDropdownMenu.Content
      {...props}
      collisionBoundary={props.collisionBoundary ?? appCollisionBoundary()}
    />
  );
}
export const Item = RadixDropdownMenu.Item;
export const CheckboxItem = RadixDropdownMenu.CheckboxItem;
export const RadioGroup = RadixDropdownMenu.RadioGroup;
export const RadioItem = RadixDropdownMenu.RadioItem;
export const ItemIndicator = RadixDropdownMenu.ItemIndicator;
export const Label = RadixDropdownMenu.Label;
export const Separator = RadixDropdownMenu.Separator;
