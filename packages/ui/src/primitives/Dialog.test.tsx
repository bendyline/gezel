import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as AlertDialog from './AlertDialog.js';
import * as Dialog from './Dialog.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dialog primitive wrappers', () => {
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
