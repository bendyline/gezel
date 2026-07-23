import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu';

// Keep Radix behind the shared primitives barrel so menu behavior and
// animation remain one edit away from a global change.
export const Root = RadixDropdownMenu.Root;
export const Trigger = RadixDropdownMenu.Trigger;
export const Portal = RadixDropdownMenu.Portal;
export const Content = RadixDropdownMenu.Content;
export const Item = RadixDropdownMenu.Item;
