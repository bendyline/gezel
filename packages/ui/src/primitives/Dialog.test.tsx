import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import * as AlertDialog from './AlertDialog.js';
import * as Dialog from './Dialog.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dialog primitive wrappers', () => {
  for (const hidesLauncher of [false, true])
    it(`restores controlled dialog focus when its launcher ${hidesLauncher ? 'is hidden by navigation' : 'remains visible'}`, async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        const [navigated, setNavigated] = useState(false);
        return (
          <>
            <nav hidden={hidesLauncher && navigated}>
              <button
                type="button"
                onClick={() => {
                  setOpen(true);
                  setNavigated(true);
                }}
              >
                New project
              </button>
            </nav>
            <main tabIndex={-1}>Project destination</main>
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Portal>
                <Dialog.Content>
                  <Dialog.Title>Create project</Dialog.Title>
                  <Dialog.Description>Choose a project name.</Dialog.Description>
                  <Dialog.Close>Cancel</Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </>
        );
      }
      render(<Example />);
      const launcher = screen.getByRole('button', { name: 'New project' });
      await user.click(launcher);
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(hidesLauncher ? screen.getByRole('main') : launcher).toHaveFocus(),
      );
    });
  it('forwards DOM refs, manages focus, and emits no dropped-ref warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const overlayRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    const user = userEvent.setup();

    render(
      <Dialog.Root>
        <Dialog.Trigger>Open dialog</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay ref={overlayRef} />
          <Dialog.Content ref={contentRef}>
            <Dialog.Title>Example dialog</Dialog.Title>
            <Dialog.Description>An accessible test dialog.</Dialog.Description>
            <Dialog.Close>Close dialog</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    const close = await screen.findByRole('button', { name: 'Close dialog' });

    expect(overlayRef.current).toBeInstanceOf(HTMLDivElement);
    expect(contentRef.current).toBeInstanceOf(HTMLDivElement);
    await waitFor(() => expect(close).toHaveFocus());

    await user.tab();
    expect(close).toHaveFocus();
    await user.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());

    expect(
      error.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes('Function components cannot be given refs')),
      ),
    ).toBe(false);
  });
});

describe('AlertDialog primitive wrappers', () => {
  for (const removesLauncher of [false, true])
    it(`restores controlled confirmation focus when its launcher ${removesLauncher ? 'was removed' : 'remains visible'}`, async () => {
      const user = userEvent.setup();
      function Example() {
        const [open, setOpen] = useState(false);
        const [removed, setRemoved] = useState(false);
        return (
          <>
            {!removed && (
              <button type="button" onClick={() => setOpen(true)}>
                Delete task
              </button>
            )}
            <main tabIndex={-1}>Tasks</main>
            <ConfirmDialog
              open={open}
              title="Delete this task?"
              message="The task will be removed."
              onCancel={() => setOpen(false)}
              onConfirm={() => {
                setRemoved(true);
                setOpen(false);
              }}
            />
          </>
        );
      }
      render(<Example />);
      const launcher = screen.getByRole('button', { name: 'Delete task' });
      await user.click(launcher);
      await screen.findByRole('alertdialog');
      if (removesLauncher) await user.click(screen.getByRole('button', { name: 'Confirm' }));
      else await user.keyboard('{Escape}');
      await waitFor(
        () => expect(removesLauncher ? screen.getByRole('main') : launcher).toHaveFocus(),
        { timeout: 1000 },
      );
    });
  it('forwards DOM refs and restores focus without dropped-ref warnings', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const overlayRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    const user = userEvent.setup();

    render(
      <AlertDialog.Root>
        <AlertDialog.Trigger>Delete item</AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay ref={overlayRef} />
          <AlertDialog.Content ref={contentRef}>
            <AlertDialog.Title>Delete this item?</AlertDialog.Title>
            <AlertDialog.Description>This cannot be undone.</AlertDialog.Description>
            <AlertDialog.Cancel>Cancel deletion</AlertDialog.Cancel>
            <AlertDialog.Action>Confirm deletion</AlertDialog.Action>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>,
    );

    const trigger = screen.getByRole('button', { name: 'Delete item' });
    await user.click(trigger);
    const cancel = await screen.findByRole('button', { name: 'Cancel deletion' });

    expect(overlayRef.current).toBeInstanceOf(HTMLDivElement);
    expect(contentRef.current).toBeInstanceOf(HTMLDivElement);
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.click(cancel);
    await waitFor(() => expect(trigger).toHaveFocus());

    expect(
      error.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes('Function components cannot be given refs')),
      ),
    ).toBe(false);
  });
});
