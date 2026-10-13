import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="portrait" data-name={name} />,
}));

const { CrewIntroCard } = await import('./CrewIntroCard.js');

describe('CrewIntroCard', () => {
  const intro = {
    taskRef: 'p1/1',
    moment: 'kickoff' as const,
    members: [
      {
        gezelId: 'g-mira',
        name: 'Mira',
        role: 'Reisleider',
        gloss: 'trip planner',
        stepName: 'First draft',
      },
      { gezelId: 'g-ana', name: 'Anastasia', role: 'Voorman', gloss: 'crew lead' },
    ],
  };

  it('shows each gezel with a portrait and their role in plain words', () => {
    render(<CrewIntroCard intro={intro} />);
    expect(screen.getByText('Your crew')).toBeInTheDocument();
    expect(screen.getAllByTestId('portrait').map((p) => p.dataset.name)).toEqual([
      'Mira',
      'Anastasia',
    ]);
    expect(screen.getByText('Reisleider — trip planner')).toBeInTheDocument();
    expect(screen.getByText('Starts with “First draft”')).toBeInTheDocument();
  });

  it('opens a chat with the gezel from Say hello', () => {
    const events: CustomEvent[] = [];
    const record = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('gezel:open-tab', record);
    try {
      render(<CrewIntroCard intro={intro} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Say hello' })[0]!);
    } finally {
      window.removeEventListener('gezel:open-tab', record);
    }
    expect(events.at(-1)?.detail).toMatchObject({ kind: 'gezel', id: 'g-mira' });
  });
});
