import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted, so the spy has to be created inside the factory and
// read back through the mocked module rather than closed over here.
vi.mock('../../components/composer-prefill.js', () => ({ queueComposerPrefill: vi.fn() }));
vi.mock('../../components/GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
}));

import { queueComposerPrefill } from '../../components/composer-prefill.js';
import { MeesterGreeting } from './MeesterGreeting.js';

const prefill = vi.mocked(queueComposerPrefill);

/**
 * The workshop opened as a blank panel: the product's pitch is a crew of named
 * companions, and a first-time user met an empty room. This is static rather
 * than a seeded model turn, so it renders while a model is still downloading
 * and never attributes words to the meester that they did not produce.
 */
describe('MeesterGreeting', () => {
  beforeEach(() => prefill.mockClear());

  const props = {
    meesterName: 'Ulrike',
    meesterIcon: null,
    meesterPoppetje: null,
    meesterIconOverride: false,
    projectId: 'default',
  };

  it('introduces the meester by name and says what they do', () => {
    render(<MeesterGreeting {...props} />);
    expect(screen.getByText(/I'm Ulrike, your meester/)).toBeInTheDocument();
    expect(screen.getByText(/which gezellen you need/)).toBeInTheDocument();
  });

  it('prefills an opener into the composer instead of sending it', () => {
    render(<MeesterGreeting {...props} />);
    const opener = screen.getByRole('button', { name: /start a project/i });
    fireEvent.click(opener);

    // Prefill, not send — the user reads what they are about to ask.
    expect(prefill).toHaveBeenCalledWith('default', expect.stringContaining('project'));
  });

  it('scopes the prefill to the conversation’s project', () => {
    render(<MeesterGreeting {...props} projectId="alpha" />);
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(prefill).toHaveBeenCalledWith('alpha', expect.any(String));
  });
});
