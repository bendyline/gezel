import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { isBackDismiss } from '../back-dismiss.js';
import * as Dialog from '../primitives/Dialog.js';
import { useBackNavigation } from './useBackNavigation.js';

function back() {
  let handled = false;
  act(() => {
    handled = !window.dispatchEvent(new CustomEvent('gezel:back', { cancelable: true }));
  });
  return handled;
}
function Example({ compact = true }: { compact?: boolean }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  useBackNavigation(compact, navigationOpen, () => setNavigationOpen(true));
  return (
    <>
      <nav hidden={!navigationOpen}>Workshop navigation</nav>
      <main hidden={navigationOpen}>
        <textarea aria-label="Draft" defaultValue="Keep my draft" />
        <Dialog.Root>
          <Dialog.Trigger>New project</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Content>
              <Dialog.Title>Create project</Dialog.Title>
              <Dialog.Description>Choose a name.</Dialog.Description>
              <Dialog.Close>Cancel</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </main>
    </>
  );
}

describe('native Back with the shared responsive app', () => {
  it('opens navigation without discarding the draft, then lets the host handle Back', () => {
    render(<Example />);
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.change(draft, { target: { value: 'An unfinished thought' } });
    expect(back()).toBe(true);
    expect(screen.getByRole('navigation')).toBeVisible();
    expect(draft).toHaveValue('An unfinished thought');
    expect(back()).toBe(false);
  });
  it('dismisses the active dialog before navigating', async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    await screen.findByRole('dialog');
    expect(back()).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('main')).toBeVisible();
    expect(back()).toBe(true);
    expect(screen.getByRole('navigation')).toBeVisible();
  });
  it('preserves host navigation in a wide desktop layout and removes its listener on unmount', () => {
    const view = render(<Example compact={false} />);
    expect(back()).toBe(false);
    view.unmount();
    expect(back()).toBe(false);
  });
});

describe('Back never abandons work underneath an overlay', () => {
  it('marks its dismissal so an Escape shortcut can tell it from a key press', () => {
    const seen = { real: 0, fromBack: 0 };
    const listener = (event: Event) => {
      if (isBackDismiss(event)) seen.fromBack += 1;
      else seen.real += 1;
    };
    window.addEventListener('keydown', listener);
    // An overlay nothing else dismisses: exactly the shape that let Back reach
    // the composer's cancel shortcut and stop a running reply.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    try {
      render(<Example />);
      back();
      expect(seen.fromBack).toBe(1);
      expect(seen.real).toBe(0);

      // A real key press stays unmarked, so the shortcut still works.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(seen.real).toBe(1);
    } finally {
      menu.remove();
      window.removeEventListener('keydown', listener);
    }
  });
});
