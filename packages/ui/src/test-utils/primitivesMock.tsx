import { type ReactNode, createContext, useContext, useId } from 'react';

/**
 * Test-only replacement for `../primitives/index.js`. Renders the Radix
 * primitives the views use as plain HTML so tests don't have to fight
 * portal/positioning logic in jsdom.
 *
 * Coverage so far: `Select` (the most-used primitive in views). Add
 * `Dialog`, `Tabs`, etc. as new view tests need them.
 *
 * Use:
 *
 *   vi.mock('../primitives/index.js', () => primitivesMock);
 */

interface SelectRootProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  children?: ReactNode;
  disabled?: boolean;
}

interface SelectItemProps {
  value: string;
  children?: ReactNode;
  disabled?: boolean;
  /** Radix's plain-text representation of a rich item row. */
  textValue?: string;
}

/** Flatten a ReactNode to its visible text (option labels are text-only). */
function nodeText(n: ReactNode): string {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join('');
  if (typeof n === 'object' && 'props' in n) {
    return nodeText((n as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

const Select = {
  Root: ({ value, defaultValue, onValueChange, children, disabled }: SelectRootProps) => {
    // Walk children to collect items. The tests don't need positioned
    // popovers — render every Item as a real <option> so the user can
    // pick by visible text via fireEvent.change.
    const options: Array<{ value: string; label: ReactNode }> = [];
    const walk = (n: ReactNode): void => {
      if (n == null || typeof n === 'boolean') return;
      if (Array.isArray(n)) {
        for (const c of n) walk(c);
        return;
      }
      if (typeof n === 'object' && 'props' in n) {
        const props = (
          n as { props?: { value?: string; children?: ReactNode; textValue?: string } }
        ).props;
        if (props && typeof props.value === 'string') {
          // Prefer Radix's `textValue` for rich rows — same plain-text
          // channel the real Select uses for typeahead.
          options.push({
            value: props.value,
            label: props.textValue ?? props.children ?? props.value,
          });
        }
        if (props?.children) walk(props.children);
      }
    };
    walk(children);
    return (
      <select
        data-testid="mock-select"
        value={value ?? defaultValue ?? ''}
        disabled={disabled}
        onChange={(e) => onValueChange?.(e.currentTarget.value)}
      >
        {options.map((o, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <option key={`${o.value}-${i}`} value={o.value}>
            {typeof o.label === 'string' ? o.label : nodeText(o.label)}
          </option>
        ))}
      </select>
    );
  },
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Value: () => null,
  Content: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Item: ({ value, children }: SelectItemProps) => (
    <span data-mock-select-item={value}>{children}</span>
  ),
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Separator: () => null,
};

const Dialog = {
  // Honor `open` so tests can assert the dialog disappears between
  // renders. Radix Dialog renders nothing when open is false.
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open === false ? null : <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
  // Test mock for Radix Dialog.Content. Native <dialog> would default to
  // display:none until .showModal(), so testing-library's getByText would
  // fail synchronously; the role="dialog" div renders inline like Radix's
  // own portaled-but-visible content, which is what these tests assume.
  // biome-ignore lint/a11y/useSemanticElements: see comment above
  Content: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  Title: ({ children, asChild }: { children?: ReactNode; asChild?: boolean }) => {
    // When `asChild` is true, Radix renders the child directly instead
    // of wrapping in <h2> — match that to avoid invalid <h3>-in-<h2>.
    if (asChild) return <>{children}</>;
    const id = useId();
    return <h2 id={id}>{children}</h2>;
  },
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => null,
  // Custom slot from primitives/Dialog.tsx — not part of Radix.
  Actions: ({ children }: { children?: ReactNode }) => (
    <div className="gz-dialog-actions">{children}</div>
  ),
  // AlertDialog-only slots (AlertDialog aliases Dialog below). Both are
  // asChild passthroughs in ConfirmDialog, so render children directly.
  Cancel: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
  Action: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
};

const AlertDialog = Dialog;

const TabsCtx = createContext<{ onValueChange?: (v: string) => void; value?: string }>({});

const Tabs = {
  Root: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => <TabsCtx.Provider value={{ value, onValueChange }}>{children}</TabsCtx.Provider>,
  List: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
  Trigger: ({ children, value }: { children?: ReactNode; value: string }) => {
    const ctx = useContext(TabsCtx);
    return (
      <button
        type="button"
        role="tab"
        data-value={value}
        aria-selected={ctx.value === value}
        onClick={() => ctx.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
  Content: ({ children, value }: { children?: ReactNode; value: string }) => {
    const ctx = useContext(TabsCtx);
    if (ctx.value !== undefined && ctx.value !== value) return null;
    return (
      <div role="tabpanel" data-value={value}>
        {children}
      </div>
    );
  },
};

const Tooltip = {
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

const Popover = {
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
  Anchor: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Close: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
};

const DropdownMenu = {
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div role="menu">{children}</div>,
  Item: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
};

export const primitivesMock = {
  Select,
  Dialog,
  AlertDialog,
  Tabs,
  Tooltip,
  Popover,
  DropdownMenu,
};

// Re-export under named keys so consumers can do:
//   vi.mock('../primitives/index.js', () => primitivesMock);
export { Select, Dialog, AlertDialog, Tabs, Tooltip, Popover, DropdownMenu };
