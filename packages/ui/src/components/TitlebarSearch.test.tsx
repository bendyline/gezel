import type { UnifiedSearchResult } from '@bendyline/gezel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

import { api } from '../api.js';
import { TitlebarSearch } from './TitlebarSearch.js';

const RESULTS: UnifiedSearchResult[] = [
  { kind: 'project', id: 'project:p1', title: 'Space Shooter', projectId: 'p1', score: 900 },
  {
    kind: 'file',
    id: 'file:p1:src/index.html',
    title: 'index.html',
    subtitle: 'Space Shooter · src/index.html',
    projectId: 'p1',
    path: 'src/index.html',
    source: 'workspace',
    score: 600,
  },
];

beforeEach(() => {
  window.__GEZEL__ = { ...window.__GEZEL__!, platform: 'win32' };
  vi.mocked(api.search).mockResolvedValue({ results: RESULTS, truncated: false });
  vi.mocked(api.quickOpen).mockResolvedValue({ results: RESULTS, truncated: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Row text, reassembled. Matched query terms are split into `<mark>`, so a
 * plain `getByText('Space Shooter')` no longer finds the title.
 */
function optionTexts(): string[] {
  return screen.getAllByTestId('search-option').map((el) => el.textContent ?? '');
}

async function typeQuery(value: string) {
  const input = screen.getByTestId('titlebar-search-input');
  fireEvent.change(input, { target: { value } });
  // Flush the 150ms debounce + the resolved fetch.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  return input;
}

describe('TitlebarSearch', () => {
  it('uses the native platform modifier in the shortcut hint', () => {
    const { unmount } = render(<TitlebarSearch />);
    expect(screen.getByPlaceholderText(/Ctrl\+P$/)).toBeInTheDocument();
    unmount();

    window.__GEZEL__ = { ...window.__GEZEL__!, platform: 'darwin' };
    render(<TitlebarSearch />);
    expect(screen.getByPlaceholderText(/⌘P$/)).toBeInTheDocument();
  });

  it('renders grouped results after typing', async () => {
    render(<TitlebarSearch />);
    await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Files')).toBeTruthy();
    expect(optionTexts()).toEqual([
      expect.stringContaining('Space Shooter'),
      expect.stringContaining('index.html'),
    ]);
  });

  it('marks the typed terms in the rows', async () => {
    render(<TitlebarSearch />);
    await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    // Both the title and the path-bearing subtitle carry "Space"; the mark
    // belongs on the title, and the row still reads as one sentence.
    const marks = screen.getAllByText('Space', { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.closest('[data-testid="search-option"]')?.textContent).toContain(
      'Space Shooter',
    );
  });

  it('navigates with arrow keys and dispatches events on Enter', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<TitlebarSearch />);
    const input = await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    // Move to the second option (the file) and select it.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    const types = dispatch.mock.calls
      .map((c) => c[0])
      .filter((e): e is CustomEvent => e instanceof CustomEvent)
      .map((e) => e.type);
    expect(types).toContain('gezel:open-tab');
    expect(types).toContain('gezel:open-file');
  });

  it('selecting the first (project) result opens that project', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<TitlebarSearch />);
    const input = await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    fireEvent.keyDown(input, { key: 'Enter' }); // activeIndex 0 = project

    const openTab = dispatch.mock.calls
      .map((c) => c[0])
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === 'gezel:open-tab');
    expect(openTab?.detail).toEqual({ kind: 'project', id: 'p1' });
  });

  it('focuses the input on gezel:focus-search', () => {
    render(<TitlebarSearch />);
    act(() => {
      window.dispatchEvent(new CustomEvent('gezel:focus-search', { detail: { mode: 'search' } }));
    });
    expect(document.activeElement).toBe(screen.getByTestId('titlebar-search-input'));
  });

  it('Escape closes the palette', async () => {
    render(<TitlebarSearch />);
    const input = await typeQuery('space');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  /**
   * The palette used to mount only once a response arrived, which made the
   * "Searching…" state unreachable on the first query — and the first full
   * search pays the embedding model's cold load, so the box sat mute for as
   * long as that took. Acknowledging the keystroke is the whole fix.
   */
  it('says it is searching while the first request is still in flight', async () => {
    let releaseQuick: ((v: { results: UnifiedSearchResult[]; truncated: boolean }) => void) | null =
      null;
    vi.mocked(api.quickOpen).mockReturnValue(
      new Promise((resolve) => {
        releaseQuick = resolve;
      }),
    );

    render(<TitlebarSearch />);
    await typeQuery('space');

    expect(screen.getByText('Searching…')).toBeInTheDocument();
    expect(screen.queryByText('No results')).toBeNull();

    await act(async () => {
      releaseQuick?.({ results: RESULTS, truncated: false });
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  });

  it('shows name matches before the slower content search returns', async () => {
    const nameOnly: UnifiedSearchResult[] = [RESULTS[0]!];
    let releaseFull: ((v: { results: UnifiedSearchResult[]; truncated: boolean }) => void) | null =
      null;
    vi.mocked(api.quickOpen).mockResolvedValue({ results: nameOnly, truncated: false });
    vi.mocked(api.search).mockReturnValue(
      new Promise((resolve) => {
        releaseFull = resolve;
      }),
    );

    render(<TitlebarSearch />);
    await typeQuery('space');

    // Phase one is on screen, and the row says more is still coming.
    expect(optionTexts()).toEqual([expect.stringContaining('Space Shooter')]);
    expect(screen.getByText(/Searching your files and memories/)).toBeInTheDocument();

    await act(async () => {
      releaseFull?.({ results: RESULTS, truncated: false });
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() =>
      expect(optionTexts()).toEqual([
        expect.stringContaining('Space Shooter'),
        expect.stringContaining('index.html'),
      ]),
    );
    expect(screen.queryByText(/Searching your files and memories/)).toBeNull();
  });

  it('distinguishes a failed lookup from a genuine no-match', async () => {
    vi.mocked(api.quickOpen).mockRejectedValue(new Error('Failed to fetch'));
    vi.mocked(api.search).mockRejectedValue(new Error('Failed to fetch'));

    render(<TitlebarSearch />);
    await typeQuery('space');

    expect(screen.getByText(/Search isn't responding/)).toBeInTheDocument();
    expect(screen.queryByText('No results')).toBeNull();
  });

  it("anchors the palette to the search well's left edge, not its center", async () => {
    // The well is the header's only shrinkable child, so a status pill
    // expanding narrows it. Centered, the open palette slid sideways under
    // the reader; the left edge is the coordinate that holds still.
    render(<TitlebarSearch />);
    await typeQuery('space');
    await waitFor(() => expect(screen.getByTestId('search-palette')).toBeTruthy());

    const content = screen.getByTestId('search-palette').closest('[data-align]');
    expect(content?.getAttribute('data-align')).toBe('start');
  });

  it('caps a noisy group so a better-ranked kind stays on screen', async () => {
    // The regression this guards: 25 identically-scored `SKILL.md` fuzzy
    // matches filled the palette and pushed the top-ranked library document
    // below the fold.
    const noisy: UnifiedSearchResult[] = [
      {
        kind: 'document',
        id: 'document:lesson.docx',
        title: 'Lesson Plan.docx',
        path: 'lesson.docx',
        score: 680,
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        kind: 'file' as const,
        id: `file:p1:skills/${i}/SKILL.md`,
        title: 'SKILL.md',
        projectId: 'p1',
        path: `skills/${i}/SKILL.md`,
        source: 'workspace' as const,
        score: 285,
      })),
    ];
    vi.mocked(api.quickOpen).mockResolvedValue({ results: noisy, truncated: false });
    vi.mocked(api.search).mockResolvedValue({ results: noisy, truncated: false });

    render(<TitlebarSearch />);
    await typeQuery('kim');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());

    const options = screen.getAllByTestId('search-option');
    expect(options).toHaveLength(6); // 1 document + 5 of 9 files
    expect(options[0]?.textContent).toContain('Lesson Plan.docx');
    expect(screen.getByText('+4 more')).toBeInTheDocument();
  });

  it('still reports an honest empty result when nothing matches', async () => {
    vi.mocked(api.quickOpen).mockResolvedValue({ results: [], truncated: false });
    vi.mocked(api.search).mockResolvedValue({ results: [], truncated: false });

    render(<TitlebarSearch />);
    await typeQuery('zzqqxx');

    expect(screen.getByText('No results')).toBeInTheDocument();
  });
});
