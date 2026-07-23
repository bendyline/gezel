import * as RadixDialog from '@radix-ui/react-dialog';
import { type ComponentPropsWithoutRef, type ElementRef, type ReactNode, forwardRef } from 'react';

export const Root = RadixDialog.Root;
export const Trigger = RadixDialog.Trigger;
export const Portal = RadixDialog.Portal;
export const Close = RadixDialog.Close;
export const Title = RadixDialog.Title;
export const Description = RadixDialog.Description;

export const Overlay = forwardRef<
  ElementRef<typeof RadixDialog.Overlay>,
  ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(function Overlay({ className, ...rest }, ref) {
  return (
    <RadixDialog.Overlay
      {...rest}
      ref={ref}
      className={className ? `gz-overlay ${className}` : 'gz-overlay'}
    />
  );
});
Overlay.displayName = RadixDialog.Overlay.displayName;

export const Content = forwardRef<
  ElementRef<typeof RadixDialog.Content>,
  ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(function Content({ className, ...rest }, ref) {
  return (
    <RadixDialog.Content
      {...rest}
      ref={ref}
      className={className ? `gz-dialog ${className}` : 'gz-dialog'}
    />
  );
});
Content.displayName = RadixDialog.Content.displayName;

export function Actions({ children }: { children: ReactNode }) {
  return <div className="gz-dialog-actions">{children}</div>;
}
