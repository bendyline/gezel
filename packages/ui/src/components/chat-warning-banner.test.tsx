import { CONDENSED_TOOL_OUTPUT_NOTICE, autoCompactedNotice } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { takePendingSettingsSection } from '../settings-nav.js';
import { WarningBanner } from './chat-bubbles.js';

describe('WarningBanner', () => {
  beforeEach(() => {
    takePendingSettingsSection();
  });

  it('links an actionable model update warning to its local-engine settings page', () => {
    let navigation: { view?: string; section?: string } | undefined;
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<{ view?: string; section?: string }>).detail;
    };
    window.addEventListener('gezel:navigate', onNavigate);

    const { container } = render(
      <WarningBanner
        warnings={[
          {
            type: 'warning',
            message:
              'A newer version of Qwen 3.6 27B is available. You can download it in Settings.',
            action: { kind: 'settings', section: 'mlx' },
          },
        ]}
      />,
    );

    expect(container.querySelector('.msg-warning-banner')).toHaveTextContent(
      'A newer version of Qwen 3.6 27B is available. You can download it in Settings.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(takePendingSettingsSection()).toBe('mlx');
    expect(navigation).toEqual({ view: 'settings', section: 'mlx' });
    window.removeEventListener('gezel:navigate', onNavigate);
  });

  it('keeps ordinary string warnings as plain text and deduplicates them', () => {
    render(<WarningBanner warnings={['Provider is busy.', 'Provider is busy.']} />);

    expect(screen.getAllByText(/Provider is busy/)).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('drops the warning glyph for context-maintenance notes only', () => {
    const { container } = render(
      <WarningBanner
        warnings={[
          autoCompactedNotice(34, 40_960),
          CONDENSED_TOOL_OUTPUT_NOTICE,
          'Provider is busy.',
        ]}
      />,
    );

    const rows = Array.from(container.querySelectorAll('.msg-warning-banner > div'));
    expect(rows.map((row) => row.textContent?.startsWith('⚠'))).toEqual([false, false, true]);
  });
});
