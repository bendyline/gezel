import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowserPane } from './FileBrowserPane.js';
import type { FileBrowserSource } from './source.js';
import type { FileMutations } from './useFileMutations.js';

vi.mock('../FileViewModeKeys.js', () => ({
  FileViewModeKeys: () => null,
  FileHiddenKey: () => null,
  FileRevealKey: () => null,
}));

const entry = { name: 'notes.md', path: 'notes.md', isDirectory: false };
const source = { kind: 'workspace', title: 'Workspace', canWrite: false } as FileBrowserSource;
const mutations = {
  dialogs: null,
  status: '',
  activeDropZone: null,
  dropZoneProps: () => ({}),
} as unknown as FileMutations;

function Browser() {
  const [selectedPath, setSelectedPath] = useState<string>();
  return (
    <FileBrowserPane
      source={source}
      entries={[entry]}
      selectedPath={selectedPath}
      onSelect={(file) => setSelectedPath(file.path)}
      viewMode="tree-alpha"
      modes={['tree-alpha']}
      onViewModeChange={() => {}}
      showHidden={false}
      onShowHiddenChange={() => {}}
      emptyMessage="No files"
      mutations={mutations}
      viewer={<textarea aria-label="Document draft" defaultValue="Original" />}
    />
  );
}

describe('FileBrowserPane narrow navigation', () => {
  let width = 390;
  const observers = new Set<() => void>();

  beforeEach(() => {
    width = 390;
    window.localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.add(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    observers.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens files full width and keeps the same editor and draft when returning to the list', () => {
    render(<Browser />);
    const editor = screen.getByLabelText('Document draft');
    expect(editor).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));
    expect(editor).toBeVisible();
    fireEvent.change(editor, { target: { value: 'Unsaved draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }));
    expect(editor).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));
    expect(screen.getByLabelText('Document draft')).toBe(editor);
    expect(editor).toHaveValue('Unsaved draft');
  });

  it('restores the desktop split without changing its saved width or collapse preference', () => {
    window.localStorage.setItem('gezel:project-file-tree-width:v1', '360');
    window.localStorage.setItem('gezel:project-file-tree-collapsed:v1', '1');
    render(<Browser />);
    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));
    const editor = screen.getByLabelText('Document draft');
    act(() => {
      width = 768;
      for (const notify of observers) notify();
    });
    expect(screen.queryByRole('button', { name: 'Back to files' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show Workspace files' })).toBeVisible();
    expect(screen.getByLabelText('Document draft')).toBe(editor);
    expect(window.localStorage.getItem('gezel:project-file-tree-width:v1')).toBe('360');
    expect(window.localStorage.getItem('gezel:project-file-tree-collapsed:v1')).toBe('1');
  });
});

describe('FileBrowserPane tree collapse', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 1024);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function Pane({ collapseTreeRequest }: { collapseTreeRequest?: number | null }) {
    return (
      <FileBrowserPane
        source={source}
        entries={[entry]}
        selectedPath="notes.md"
        onSelect={() => {}}
        viewMode="tree-alpha"
        modes={['tree-alpha']}
        onViewModeChange={() => {}}
        showHidden={false}
        onShowHiddenChange={() => {}}
        emptyMessage="No files"
        mutations={mutations}
        collapseTreeRequest={collapseTreeRequest}
        viewer={<textarea aria-label="Document draft" defaultValue="Original" />}
      />
    );
  }

  // Dragging the grip past its threshold was the only way to fold the tree.
  it('hides and shows the tree from its own keys and remembers the choice', () => {
    render(<Pane />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Workspace files' }));
    expect(screen.queryByRole('button', { name: 'notes.md' })).toBeNull();
    expect(window.localStorage.getItem('gezel:project-file-tree-collapsed:v1')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace files' }));
    expect(screen.getByRole('button', { name: 'notes.md' })).toBeVisible();
    expect(window.localStorage.getItem('gezel:project-file-tree-collapsed:v1')).toBe('0');
  });

  it('folds for a host request without storing it, and an answered request stays answered', () => {
    const { rerender } = render(<Pane collapseTreeRequest={1} />);
    expect(screen.queryByRole('button', { name: 'notes.md' })).toBeNull();
    expect(window.localStorage.getItem('gezel:project-file-tree-collapsed:v1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace files' }));
    expect(screen.getByRole('button', { name: 'notes.md' })).toBeVisible();
    rerender(<Pane collapseTreeRequest={1} />);
    expect(screen.getByRole('button', { name: 'notes.md' })).toBeVisible();

    rerender(<Pane collapseTreeRequest={2} />);
    expect(screen.queryByRole('button', { name: 'notes.md' })).toBeNull();

    rerender(<Pane collapseTreeRequest={null} />);
    expect(screen.getByRole('button', { name: 'notes.md' })).toBeVisible();
  });
});

describe('FileBrowserPane viewer notice', () => {
  // A person who opened a quote from a review question had no way back to it.
  it('renders the notice above the viewer at full width', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    try {
      render(
        <FileBrowserPane
          source={source}
          entries={[entry]}
          selectedPath="notes.md"
          onSelect={() => {}}
          viewMode="tree-alpha"
          modes={['tree-alpha']}
          onViewModeChange={() => {}}
          showHidden={false}
          onShowHiddenChange={() => {}}
          emptyMessage="No files"
          mutations={mutations}
          viewerNotice={<button type="button">Back to the question</button>}
          viewer={<textarea aria-label="Document draft" defaultValue="Original" />}
        />,
      );
      const back = screen.getByRole('button', { name: 'Back to the question' });
      const viewer = screen.getByLabelText('Document draft');
      expect(back.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
