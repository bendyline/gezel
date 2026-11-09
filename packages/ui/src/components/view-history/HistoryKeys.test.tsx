import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { toRecentTab } from '../recent-tabs.js';
import { HistoryKeys } from './HistoryKeys.js';
import {
  ViewHistoryProvider,
  useViewHistoryApi,
  useViewHistoryState,
} from './ViewHistoryContext.js';

function Harness() {
  const [state, dispatch] = useViewHistoryState(null);
  const api = useViewHistoryApi(state, dispatch);
  return (
    <ViewHistoryProvider value={api}>
      <HistoryKeys />
      <button
        type="button"
        onClick={() => {
          dispatch({ type: 'push', selection: toRecentTab({ kind: 'project', id: 'p1' }) });
          dispatch({ type: 'set-title', selectionKey: 'project:p1', title: 'Invoices' });
          dispatch({
            type: 'set-part',
            scope: 'project',
            part: { key: 'tasks', value: 'tasks', label: 'Tasks' },
            selectionKey: 'project:p1',
            annotate: false,
          });
          dispatch({ type: 'push', selection: toRecentTab({ kind: 'area', area: 'settings' }) });
        }}
      >
        Visit two views
      </button>
    </ViewHistoryProvider>
  );
}

const key = (testId: string) => screen.getByTestId(testId);

describe('HistoryKeys', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('has nowhere to go on a fresh trail', () => {
    render(<Harness />);
    expect(key('history-back')).toBeDisabled();
    expect(key('history-forward')).toBeDisabled();
    expect(key('history-trail')).toBeDisabled();
    expect(screen.getByRole('toolbar', { name: 'Back and forward' })).toBeInTheDocument();
  });

  it('names where Back and Forward lead', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Visit two views' }));
    expect(key('history-back')).toHaveAccessibleName('Back to Invoices · Tasks');
    expect(key('history-forward')).toBeDisabled();
    fireEvent.click(key('history-back'));
    expect(key('history-back')).toHaveAccessibleName('Back to Home');
    expect(key('history-forward')).toHaveAccessibleName('Forward to Settings');
  });

  it('lists the trail newest first and jumps to a pick', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Visit two views' }));
    fireEvent.pointerDown(key('history-trail'), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu', { name: 'Views you have visited' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Settings', 'InvoicesTasks', 'Home']);
    expect(items[0]).toHaveAttribute('aria-current', 'page');
    fireEvent.click(items[2]!);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(key('history-back')).toBeDisabled();
    expect(key('history-forward')).toHaveAccessibleName('Forward to Invoices · Tasks');
  });

  it('opens the trail from a right-click on Back', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Visit two views' }));
    fireEvent.contextMenu(key('history-back'));
    expect(await screen.findByRole('menu', { name: 'Views you have visited' })).toBeInTheDocument();
  });
});
