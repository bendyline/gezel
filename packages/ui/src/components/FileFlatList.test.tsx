import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileFlatList } from './FileFlatList.js';

const ENTRIES = [
  { path: 'docs/deep/new.md', name: 'new.md', isDirectory: false, mtimeMs: 900 },
  { path: 'root.md', name: 'root.md', isDirectory: false, mtimeMs: 100 },
];

describe('FileFlatList', () => {
  it('renders name plus muted parent path per row', () => {
    render(<FileFlatList entries={ENTRIES} onSelect={vi.fn()} />);

    const first = screen.getByRole('button', { name: /new\.md/ });
    expect(first).toHaveTextContent('docs/deep');
    expect(screen.getByRole('button', { name: /root\.md/ })).not.toHaveTextContent('/');
  });

  it('marks the selected row and fires onSelect with the entry', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FileFlatList entries={ENTRIES} selectedPath="root.md" onSelect={onSelect} />);

    expect(screen.getByRole('button', { name: /root\.md/ }).closest('.tree-row')).toHaveClass(
      'tree-row-selected',
    );

    await user.click(screen.getByRole('button', { name: /new\.md/ }));
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[0]);
  });

  it('renders host trailing content and the empty message', () => {
    const { rerender } = render(
      <FileFlatList
        entries={ENTRIES}
        onSelect={vi.fn()}
        trailingForEntry={(entry) => <span aria-label={`Trail ${entry.name}`}>x</span>}
      />,
    );
    expect(screen.getByLabelText('Trail new.md')).toBeInTheDocument();

    rerender(<FileFlatList entries={[]} onSelect={vi.fn()} emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('offers host actions from both the row menu and right-click menu', async () => {
    const user = userEvent.setup();
    const pin = vi.fn();
    const actionsForEntry = () => [{ label: 'Pin to Documents list', onSelect: pin }];
    const { rerender } = render(
      <FileFlatList entries={ENTRIES} onSelect={vi.fn()} actionsForEntry={actionsForEntry} />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions for new.md' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pin to Documents list' }));
    expect(pin).toHaveBeenCalledWith(ENTRIES[0]);

    pin.mockClear();
    rerender(
      <FileFlatList entries={[ENTRIES[1]!]} onSelect={vi.fn()} actionsForEntry={actionsForEntry} />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /^root\.md$/ }).closest('.tree-row')!);
    await user.click(await screen.findByRole('menuitem', { name: 'Pin to Documents list' }));
    expect(pin).toHaveBeenCalledWith(ENTRIES[1]);
  });
});
