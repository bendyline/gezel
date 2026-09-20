import { useEffect, useRef } from 'react';
import * as Tabs from '../primitives/Tabs.js';
import '../styles/project-section-tabs.css';

export interface ProjectSectionTab {
  value: string;
  label: string;
  disabled?: boolean;
}

/** The same section names and navigation on desktop and narrow project surfaces. */
export function ProjectSectionTabs({
  items,
  value,
  onValueChange,
  onPreload,
  compact = false,
}: {
  items: readonly ProjectSectionTab[];
  value: string;
  onValueChange: (value: string) => void;
  onPreload?: (value: string) => void;
  compact?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and layout changes can move the active tab outside the scrollport.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-state="active"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value, compact]);

  return (
    <div ref={listRef} className={`project-section-tabs${compact ? ' is-compact' : ''}`}>
      <Tabs.Root value={value} onValueChange={onValueChange}>
        <Tabs.List aria-label="Project sections">
          {items.map((item) => (
            <Tabs.Trigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              data-testid={`project-tab-${item.value}`}
              onPointerEnter={() => onPreload?.(item.value)}
              onFocus={() => onPreload?.(item.value)}
              onPointerDown={() => onPreload?.(item.value)}
            >
              {item.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
    </div>
  );
}
