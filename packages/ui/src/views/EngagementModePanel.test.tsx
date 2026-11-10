import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EngagementModePanel } from './EngagementModePanel.js';

describe('EngagementModePanel tempo', () => {
  // The tempo keys read Gezellig, Bedrijvig, Druk and Dolle boel, explained
  // as "20-minute rapid cadence, 6-hour slow" (2026-11-09).
  it('names each tempo in plain English and keeps the stored ids', () => {
    const onTempoChange = vi.fn();
    render(
      <EngagementModePanel
        mode="proactive"
        tempo="bedrijvig"
        onChange={() => {}}
        onTempoChange={onTempoChange}
      />,
    );
    const tray = screen.getByRole('radiogroup', { name: 'Tempo' });
    const keys = within(tray).getAllByRole('radio');
    expect(keys.map((key) => key.querySelector('.gz-key-label')?.textContent)).toEqual([
      'Relaxed',
      'Steady',
      'Brisk',
      'Hectic',
    ]);
    expect(document.body).not.toHaveTextContent(/Gezellig|Bedrijvig|Druk|Dolle boel|cadence/);
    expect(screen.getByText(/every 20 minutes while a project is busy/)).toBeInTheDocument();

    fireEvent.click(within(tray).getByRole('radio', { name: /Relaxed/ }));
    expect(onTempoChange).toHaveBeenCalledWith('gezellig');
  });
});
