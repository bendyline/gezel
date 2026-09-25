import * as RadixContextMenu from '@radix-ui/react-context-menu';
import type { ComponentProps } from 'react';
import { appCollisionBoundary } from './appCollisionBoundary.js';

// Keep Radix behind the shared primitives barrel so context-menu behavior
// and animation remain one edit away from a global change.
export const Root = RadixContextMenu.Root;
export const Trigger = RadixContextMenu.Trigger;
export const Portal = RadixContextMenu.Portal;
export function Content(props: ComponentProps<typeof RadixContextMenu.Content>) {
  return (
    <RadixContextMenu.Content
      {...props}
      collisionBoundary={props.collisionBoundary ?? appCollisionBoundary()}
    />
  );
}
export const Item = RadixContextMenu.Item;
export const Separator = RadixContextMenu.Separator;
