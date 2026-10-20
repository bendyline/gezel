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

  describe('a tab that carries a menu', () => {
    function MenuHarness({ onSelect = () => {} }: { onSelect?: (value: string) => void }) {
      const [value, setValue] = useState('chat');
      const [view, setView] = useState('village');
      const items: FittedTab[] = [
        ITEMS[0]!,
        {
          value: 'map',
          label: view === 'village' ? 'Village view' : 'Diagram view',
          icon: 'village',
          menu: {
            label: 'Choose a view',
            value: view,
            items: [
              { value: 'village', label: 'Village', hint: 'Your files as a town' },
              { value: 'diagram', label: 'Diagram', hint: 'What imports what' },
            ],
            onSelect: (next) => {
              setView(next);
              onSelect(next);
            },
          },
        },
      ];
      return (
        <Tabs.Root value={value} onValueChange={setValue}>
          <FittedTabsList ariaLabel="Sections" items={items} value={value} />
        </Tabs.Root>
      );
    }

    it('opens on the current choice only once the tab is current', async () => {
      rowWidth = 320;
      render(<MenuHarness />);
      const tab = screen.getByRole('tab', { name: 'Village view' });
      expect(tab).toHaveAttribute('aria-haspopup', 'menu');

      await userEvent.click(tab);
      expect(tab).toHaveAttribute('data-state', 'active');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();

      await userEvent.click(tab);
      expect(await screen.findByRole('menu', { name: 'Choose a view' })).toBeInTheDocument();
      expect(tab).toHaveAttribute('aria-expanded', 'true');
      expect(tab).toHaveAttribute('data-state', 'active');
    });

    it('switches the choice from the menu and renames the tab', async () => {
      rowWidth = 320;
      const onSelect = vi.fn();
      render(<MenuHarness onSelect={onSelect} />);
      const tab = screen.getByRole('tab', { name: 'Village view' });
      await userEvent.click(tab);
      await userEvent.click(tab);
      await userEvent.click(await screen.findByRole('menuitemradio', { name: /Diagram/ }));

      expect(onSelect).toHaveBeenCalledWith('diagram');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Diagram view' })).toHaveAttribute(
        'data-state',
        'active',
      );
    });

    it('opens from the keyboard and gives focus back to the tab', async () => {
      rowWidth = 320;
      render(<MenuHarness />);
      const tab = screen.getByRole('tab', { name: 'Village view' });
      await userEvent.click(tab);
      tab.focus();

      await userEvent.keyboard('{ArrowDown}');
      expect(await screen.findByRole('menu')).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(tab).toHaveFocus();

      await userEvent.keyboard('{Enter}');
      expect(await screen.findByRole('menu')).toBeInTheDocument();
    });

    it('measures the chevron in the faces that draw it', () => {
      rowWidth = 320;
      const { container } = render(<MenuHarness />);
      const probes = container.querySelectorAll('[data-probe-index="1"]');
      const withChevron = [...probes]
        .filter((probe) => probe.querySelector('.fitted-tab-chevron'))
        .map((probe) => probe.getAttribute('data-face'));
      expect(withChevron).toEqual(['label', 'both']);
    });
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
