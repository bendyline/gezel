import { useEffect, useRef } from 'react';
import * as Tabs from '../primitives/Tabs.js';
import { FittedTabsList } from './FittedTabsList.js';
import type { SectionIconName } from './SectionIcon.js';
import '../styles/project-section-tabs.css';

export interface ProjectSectionTab {
  value: string;
  label: string;
  icon: SectionIconName;
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
  // Icons fit the row in every layout we ship, but a phone holding every
  // optional section can still overflow; keep the current tab in view then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and layout changes can move the active tab outside the scrollport.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value, compact]);

  return (
    <div ref={listRef} className={`project-section-tabs${compact ? ' is-compact' : ''}`}>
      <Tabs.Root value={value} onValueChange={onValueChange}>
        <FittedTabsList
          ariaLabel="Project sections"
          value={value}
          onPreload={onPreload}
          items={items.map((item) => ({ ...item, testId: `project-tab-${item.value}` }))}
        />
      </Tabs.Root>
    </div>
  );
}
