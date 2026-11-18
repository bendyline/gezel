import { render, screen } from '@testing-library/react';
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
    expect(screen.getByText('Trip Planner')).toBeInTheDocument();
    expect(screen.getByText('Crew Lead')).toBeInTheDocument();
    // The plan's step name is not a schedule to read out.
    expect(screen.queryByText(/Starts with|First draft/)).not.toBeInTheDocument();
  });

  it('introduces someone hired in conversation, with no task behind them', () => {
    render(
      <CrewIntroCard
        intro={{
          moment: 'hired',
          members: [{ gezelId: 'g-tessa', name: 'Tessa', role: 'Copywriter' }],
        }}
      />,
    );
    expect(screen.getByText('Joined the crew')).toBeInTheDocument();
    expect(screen.getByText('Copywriter')).toBeInTheDocument();
  });
});
