import type { Account } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { AccountsPanel } = await import('./AccountsPanel.js');
const { api } = await import('../api.js');

const me: Account = {
  id: 'acct-me',
  name: 'Mike',
  role: 'admin',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  lastSignInAt: '2026-11-10T10:00:00.000Z',
};

const ana: Account = {
  id: 'acct-ana',
  name: 'Ana',
  role: 'admin',
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
};

function dialogNamed(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const dialog = heading.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error(`no dialog titled ${title}`);
  return dialog;
}

describe('AccountsPanel', () => {
  beforeEach(() => {
    vi.mocked(api.accounts.listAccounts).mockResolvedValue({ accounts: [me, ana], me });
    vi.mocked(api.accounts.listMySessions).mockResolvedValue({
      sessions: [
        {
          id: 'sess-1',
          accountId: me.id,
          createdAt: '2026-11-10T10:00:00.000Z',
          lastSeenAt: '2026-11-10T10:00:00.000Z',
          expiresAt: '2026-12-10T10:00:00.000Z',
          label: 'Firefox on Linux',
          current: true,
        },
      ],
    });
    vi.mocked(api.accounts.createAccount).mockReset().mockResolvedValue({ account: ana });
    vi.mocked(api.accounts.removeAccount).mockReset().mockResolvedValue({ removed: true });
  });

  it('says what accounts are for and lists who can sign in', async () => {
    render(<AccountsPanel />);

    expect(await screen.findByText('Ana')).toBeInTheDocument();
    expect(screen.getByText(/use this Gezel from a web browser/)).toBeInTheDocument();
    expect(screen.getByText(/including open a terminal/)).toBeInTheDocument();
    expect(screen.getByText("Hasn't signed in yet")).toBeInTheDocument();
    // Your own row has no menu; your account section holds its actions.
    expect(screen.getByRole('button', { name: 'Actions for Ana' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Mike' })).not.toBeInTheDocument();
    expect(screen.getByText('This browser')).toBeInTheDocument();
    // No form sits open on the page.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('adds an account from a dialog and says to hand over the password', async () => {
    render(<AccountsPanel />);
    await screen.findByText('Ana');

    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const dialog = dialogNamed('Add an account');
    const submit = within(dialog).getByRole('button', { name: 'Add account' });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Bo  ' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'long enough' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(api.accounts.createAccount).toHaveBeenCalledWith('Bo', 'long enough'),
    );
    expect(
      await screen.findByText(/Added Bo\. You'll need to share the password/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps what was typed when adding fails', async () => {
    vi.mocked(api.accounts.createAccount).mockRejectedValue(
      new Error('That name is already taken.'),
    );
    render(<AccountsPanel />);
    await screen.findByText('Ana');

    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const dialog = dialogNamed('Add an account');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Ana' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'long enough' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That name is already taken.',
    );
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Ana');
  });

  it('asks before removing someone', async () => {
    render(<AccountsPanel />);
    await screen.findByText('Ana');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    const dialog = dialogNamed('Remove Ana?');
    expect(api.accounts.removeAccount).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.accounts.removeAccount).toHaveBeenCalledWith('acct-ana'));
    expect(await screen.findByText('Removed Ana.')).toBeInTheDocument();
  });
});
