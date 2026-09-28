import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '../primitives/index.js';
import { type FittedTab, FittedTabsList, chooseTabFit } from './FittedTabsList.js';

describe('chooseTabFit', () => {
  const base = {
    gap: 4,
    labelWidths: [60, 80, 100],
    iconWidths: [34, 34, 34],
    activeIndex: 1,
    activeBothWidth: 110,
  };

  it('keeps every label while they fit, gaps included', () => {
    expect(chooseTabFit({ ...base, available: 248 })).toBe('labels');
    expect(chooseTabFit({ ...base, available: 247 })).toBe('active-label');
  });

  it('names only the current tab when that is all the row can afford', () => {
    // 34 + 110 + 34 + 2 gaps
    expect(chooseTabFit({ ...base, available: 186 })).toBe('active-label');
    expect(chooseTabFit({ ...base, available: 185 })).toBe('icons');
  });

  it('drops straight to icons when no tab is selected', () => {
    expect(chooseTabFit({ ...base, activeIndex: -1, available: 200 })).toBe('icons');
  });

  it('keeps labels for a row nobody has laid out', () => {
    expect(chooseTabFit({ ...base, available: 0 })).toBe('labels');
  });
});

const ITEMS: FittedTab[] = [
  { value: 'chat', label: 'Chat', icon: 'chat' },
  { value: 'tasks', label: 'Tasks', icon: 'tasks' },
  { value: 'workspace', label: 'Workspace', icon: 'workspace' },
  { value: 'about', label: 'Settings', icon: 'settings' },
];

const PROBE_WIDTH = { label: 80, icon: 30, both: 100 } as const;

function Harness({ initial = 'chat' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Tabs.Root value={value} onValueChange={setValue}>
      <FittedTabsList ariaLabel="Sections" items={ITEMS} value={value} />
    </Tabs.Root>
  );
}

function faces() {
  return screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-face'));
}

describe('FittedTabsList', () => {
  let rowWidth = 0;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('fitted-tabs') ? rowWidth : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const face = this.getAttribute('data-face') as keyof typeof PROBE_WIDTH | null;
      const width = this.hasAttribute('data-probe-index') && face ? PROBE_WIDTH[face] : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows labels when the row has room for all of them', () => {
    rowWidth = 320;
    render(<Harness />);
    expect(faces()).toEqual(['label', 'label', 'label', 'label']);
  });

  it('keeps the current tab named and follows the selection', async () => {
    rowWidth = 200;
    render(<Harness />);
    expect(faces()).toEqual(['both', 'icon', 'icon', 'icon']);

    await userEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    expect(faces()).toEqual(['icon', 'icon', 'both', 'icon']);
  });

  it('keeps every accessible name, and one copy of each label, when iconified', () => {
    rowWidth = 150;
    render(<Harness />);
    expect(faces()).toEqual(['icon', 'icon', 'icon', 'icon']);
    for (const item of ITEMS) {
      expect(screen.getByRole('tab', { name: item.label })).toBeInTheDocument();
      expect(screen.getAllByText(item.label)).toHaveLength(1);
    }
  });
});
