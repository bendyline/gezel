import * as RadixPopover from '@radix-ui/react-popover';

export const Root = RadixPopover.Root;
export const Trigger = RadixPopover.Trigger;
export const Anchor = RadixPopover.Anchor;
export const Portal = RadixPopover.Portal;
export const Close = RadixPopover.Close;

export function Content(props: RadixPopover.PopoverContentProps) {
  const { className, sideOffset = 6, ...rest } = props;
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        {...rest}
        sideOffset={sideOffset}
        className={className ? `gz-popover ${className}` : 'gz-popover'}
      />
    </RadixPopover.Portal>
  );
}
