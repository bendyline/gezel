import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { appCollisionBoundary } from './appCollisionBoundary.js';

// Keep Radix behind the shared primitives barrel so menu behavior and
// animation remain one edit away from a global change.
export const Root = RadixDropdownMenu.Root;
export const Trigger = RadixDropdownMenu.Trigger;
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
export const ItemIndicator = RadixDropdownMenu.ItemIndicator;
export const Label = RadixDropdownMenu.Label;
export const Separator = RadixDropdownMenu.Separator;
