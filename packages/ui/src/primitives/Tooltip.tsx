import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/**
 * Radix-backed tooltip wrapper. The native `title` attribute has a 1–2s
 * delay in Electron that makes tooltips feel broken — this renders in
 * ~200ms and survives tag overflow clipping via Radix's portal + collision
 * detection.
 */
export const Provider = RadixTooltip.Provider;
export const Root = RadixTooltip.Root;
export const Trigger = RadixTooltip.Trigger;

export function Content(props: {
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        className="gz-tooltip-content"
        side={props.side ?? 'top'}
        sideOffset={6}
      >
        {props.children}
        <RadixTooltip.Arrow className="gz-tooltip-arrow" />
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  );
}

/**
 * Shortcut for the 99% case: wrap something in a tooltip with a plain-text
 * body. Handles Provider + Root + Trigger + Content for you.
 */
export function Hint({
  text,
  children,
  side,
  delay,
}: {
  text: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}) {
  return (
    <RadixTooltip.Provider delayDuration={delay ?? 200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <Content side={side}>{text}</Content>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
