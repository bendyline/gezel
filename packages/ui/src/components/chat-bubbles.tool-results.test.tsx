import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolHistoryExpando } from './chat-bubbles.js';

describe('ToolHistoryExpando result details', () => {
  it('shows both the request and a short response in details', () => {
    render(
      <ToolHistoryExpando
        tools={[
          {
            name: 'suggest_craftbook',
            durationMs: 42,
            success: true,
            argsFull: 'query: create a PowerPoint',
            resultText: 'Matched presentations/powerpoint',
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('1 step'));
    fireEvent.click(screen.getByRole('button', { name: 'details' }));

    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText('query: create a PowerPoint')).toBeInTheDocument();
    expect(screen.getByText('Response')).toBeInTheDocument();
    expect(screen.getByText('Matched presentations/powerpoint')).toBeInTheDocument();
  });

  it('labels a bounded long response as a summary', () => {
    render(
      <ToolHistoryExpando
        tools={[
          {
            name: 'list_dir',
            durationMs: 42,
            success: true,
            resultText: 'Long response: 900 lines. Showing the beginning and end.',
            resultTruncated: true,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText('1 step'));
    fireEvent.click(screen.getByRole('button', { name: 'details' }));

    expect(screen.getByText('Response summary')).toBeInTheDocument();
  });
});
