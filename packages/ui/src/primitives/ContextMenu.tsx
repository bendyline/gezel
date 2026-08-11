import * as RadixContextMenu from '@radix-ui/react-context-menu';

// Keep Radix behind the shared primitives barrel so context-menu behavior
// and animation remain one edit away from a global change.
export const Root = RadixContextMenu.Root;
export const Trigger = RadixContextMenu.Trigger;
export const Portal = RadixContextMenu.Portal;
export const Content = RadixContextMenu.Content;
export const Item = RadixContextMenu.Item;
export const Separator = RadixContextMenu.Separator;
