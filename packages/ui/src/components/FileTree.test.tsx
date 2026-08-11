import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from './FileTree.js';

const NOTE = { path: 'notes.md', name: 'notes.md', isDirectory: false };

describe('FileTree row actions', () => {
  it('offers Rename and Delete from the three-dots menu', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <FileTree entries={[NOTE]} onSelect={onSelect} onRename={onRename} onDelete={onDelete} />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions for notes.md' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    expect(onRename).toHaveBeenCalledWith(NOTE);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('offers the same actions from the row context menu', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<FileTree entries={[NOTE]} onSelect={vi.fn()} onRename={vi.fn()} onDelete={onDelete} />);

    const row = screen.getByRole('button', { name: 'notes.md' }).closest('.tree-row');
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));

    expect(onDelete).toHaveBeenCalledWith(NOTE);
  });

  it('offers host-defined actions from the row menu', async () => {
    const user = userEvent.setup();
    const allowEditing = vi.fn();
    render(
      <FileTree
        entries={[NOTE]}
        onSelect={vi.fn()}
        actionsForEntry={() => [{ label: 'Allow editing via markdown', onSelect: allowEditing }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Actions for notes.md' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Allow editing via markdown' }));

    expect(allowEditing).toHaveBeenCalledWith(NOTE);
  });
});

describe('FileTree folder expansion', () => {
  it('does not show an expand/collapse control for an empty folder', () => {
    const emptyFolder = { path: 'drafts', name: 'drafts', isDirectory: true };

    render(<FileTree entries={[emptyFolder]} onSelect={vi.fn()} selectableFolders />);

    expect(screen.getByRole('button', { name: 'drafts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Expand|Collapse) drafts$/ })).toBeNull();
  });

  it('keeps the expand/collapse control for a folder with content', () => {
    render(
      <FileTree
        entries={[
          { path: 'drafts', name: 'drafts', isDirectory: true },
          { path: 'drafts/notes.md', name: 'notes.md', isDirectory: false },
        ]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Collapse drafts' })).toBeInTheDocument();
  });
});

describe('FileTree row status', () => {
  it('renders a host-provided read-only trailing status', () => {
    render(
      <FileTree
        entries={[NOTE]}
        onSelect={vi.fn()}
        trailingForEntry={(entry) => <span aria-label={`Status for ${entry.name}`}>2</span>}
      />,
    );

    expect(screen.getByLabelText('Status for notes.md')).toHaveTextContent('2');
  });
});
