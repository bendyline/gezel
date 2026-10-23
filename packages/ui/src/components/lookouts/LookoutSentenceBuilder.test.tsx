import type { LookoutInput } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LookoutSentenceBuilder } from './LookoutSentenceBuilder.js';

const choices = {
  cameras: [{ id: 'cam1', name: 'Mud room' }],
  mailAccounts: [{ id: 'mail1', name: 'Me at home' }],
  gezels: [],
  craftbooks: [],
};

describe('LookoutSentenceBuilder', () => {
  it('builds the cat lookout from the sentence', async () => {
    const onSave = vi.fn((_input: LookoutInput) => {});
    const user = userEvent.setup();
    render(<LookoutSentenceBuilder choices={choices} onSave={onSave} onCancel={() => {}} />);

    expect(screen.getByText('Mud room')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Something specific' }));
    await user.type(
      screen.getByRole('textbox', { name: 'What to watch for, as a yes-or-no question' }),
      'Is a cat squatting on the floor?',
    );
    await user.click(screen.getByRole('radio', { name: 'Alarm' }));
    await user.click(screen.getByRole('button', { name: 'Keep a lookout' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      name: 'a cat squatting on the floor',
      source: { kind: 'camera', bindingId: 'cam1' },
      condition: {
        kind: 'ask',
        question: 'Is a cat squatting on the floor?',
        strictness: 'normal',
      },
      actions: [{ kind: 'notify' }, { kind: 'sound', clip: 'alarm' }],
      limits: { cooldownMinutes: 10, maxPerDay: 12 },
      activeHours: null,
    });
  });

  it('says what is missing instead of saving an incomplete lookout', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<LookoutSentenceBuilder choices={choices} onSave={onSave} onCancel={() => {}} />);
    await user.click(screen.getByRole('radio', { name: 'Something specific' }));
    await user.click(screen.getByRole('button', { name: 'Keep a lookout' }));
    expect(screen.getByText('Say what to watch for, as a yes-or-no question.')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Anything moving' }));
    await user.click(screen.getByRole('checkbox', { name: /Email/ }));
    await user.click(screen.getByRole('button', { name: 'Keep a lookout' }));
    expect(screen.getByText('Who should the email go to?')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
