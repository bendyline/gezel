import * as RadixAlertDialog from '@radix-ui/react-alert-dialog';
import { type ComponentPropsWithoutRef, type ElementRef, type ReactNode, forwardRef } from 'react';
import { useDialogReturnFocus } from './useDialogReturnFocus.js';

export const Root = RadixAlertDialog.Root;
export const Trigger = RadixAlertDialog.Trigger;
export const Portal = RadixAlertDialog.Portal;
export const Cancel = RadixAlertDialog.Cancel;
export const Action = RadixAlertDialog.Action;
export const Title = RadixAlertDialog.Title;
export const Description = RadixAlertDialog.Description;

export const Overlay = forwardRef<
  ElementRef<typeof RadixAlertDialog.Overlay>,
  ComponentPropsWithoutRef<typeof RadixAlertDialog.Overlay>
>(function Overlay({ className, ...rest }, ref) {
  return (
    <RadixAlertDialog.Overlay
      {...rest}
      ref={ref}
      className={className ? `gz-overlay ${className}` : 'gz-overlay'}
    />
  );
});
Overlay.displayName = RadixAlertDialog.Overlay.displayName;

export const Content = forwardRef<
  ElementRef<typeof RadixAlertDialog.Content>,
  ComponentPropsWithoutRef<typeof RadixAlertDialog.Content>
>(function Content({ className, onOpenAutoFocus, onCloseAutoFocus, ...rest }, ref) {
  const focusHandlers = useDialogReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <RadixAlertDialog.Content
      {...rest}
      ref={ref}
      {...focusHandlers}
      className={className ? `gz-dialog ${className}` : 'gz-dialog'}
    />
  );
});
Content.displayName = RadixAlertDialog.Content.displayName;

export function Actions({ children }: { children: ReactNode }) {
  return <div className="gz-dialog-actions">{children}</div>;
}
