import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StreamingSegment } from './chat-bubbles.js';
import { StreamingBubble, ToolHistoryExpando } from './chat-bubbles.js';
import { isMachinePayload } from './tool-failures.js';

/**
 * A live turn outside debug mode. A first-hour review watched a local model
 * stream its whole deliberation and a dozen tool rows ("Preview document
 * maxItems: 4") into a bakery owner's conversation for minutes: the machine
 * room was the progress signal. The finished reply already folded all of it
 * behind Details; these pin the live bubble to the same rule.
 */

const START_CARD = {
  kind: 'craftbook-start' as const,
  craftbookId: 'report-pdf',
  craftbookName: 'Formatted Report',
  taskRef: 'bakery/2',
  projectId: 'bakery',
  status: 'active',
  activeStepId: 'outline',
  steps: [{ id: 'outline', name: 'Outline the report', status: 'active' as const }],
};

const WORKING: StreamingSegment[] = [
  { kind: 'reasoning', content: 'The user wants an invoice. I should check the book first.' },
  {
    kind: 'tool',
    tool: {
      name: 'read_file',
      durationMs: 12,
      success: true,
      projectId: 'bakery',
      argsSummary: 'Read invoices.json',
    },
  },
];

function renderLive(segments: StreamingSegment[], extra: Record<string, unknown> = {}) {
  return render(
    <StreamingBubble
      authorLabel="Dejan"
      authorIcon={null}
      segments={segments}
      startedAt={Date.now() - 5_000}
      {...extra}
    />,
  );
}

describe('StreamingBubble outside debug mode', () => {
  it('keeps the thinking and tool rows out of the conversation', () => {
    const { container } = renderLive(WORKING);

    expect(container.querySelector('.msg-stream-reasoning')).toBeNull();
    expect(container.querySelector('.thinking-tool')).toBeNull();
    expect(screen.queryByText(/I should check the book/)).not.toBeInTheDocument();
    // Still visibly working.
    expect(container.querySelector('.thinking-dots')).not.toBeNull();
  });

  it('drops the tool count from the status line', () => {
    const { container } = renderLive(WORKING);
    expect(container.querySelector('.msg-role')).not.toHaveTextContent(/\btools?\b/);
  });

  it('says what is being written in plain words while a call streams', () => {
    const { container } = renderLive([], {
      liveToolArgs: { name: 'write_file', chars: 240, head: '{"path":"invoice.md"', tail: '' },
    });

    expect(screen.getByText('Writing file…')).toBeInTheDocument();
    expect(container.querySelector('.thinking-dots')).not.toBeNull();
    expect(container.querySelector('.msg-stream-toolargs')).toBeNull();
  });

  it('calls an unmapped tool "Working…" rather than spelling its slug', () => {
    renderLive([], {
      liveToolArgs: { name: 'record_invoice', chars: 80, head: '{"client":', tail: '' },
    });
    expect(screen.getByText('Working…')).toBeInTheDocument();
    expect(screen.queryByText(/record invoice/i)).not.toBeInTheDocument();
  });

  it('lets prose stream without the dots under it', () => {
    const { container } = renderLive([{ kind: 'text', content: 'Here is the invoice for' }]);
    expect(screen.getByText('Here is the invoice for')).toBeInTheDocument();
    expect(container.querySelector('.thinking-dots')).toBeNull();
  });

  it('keeps a craftbook card in view, above the body', () => {
    const { container } = renderLive([
      {
        kind: 'tool',
        tool: {
          name: 'invoke_craftbook',
          durationMs: 900,
          success: true,
          projectId: 'bakery',
          card: START_CARD,
        },
      },
    ]);

    const card = container.querySelector('.msg-tool-card-promoted .msg-tool-card');
    expect(card).not.toBeNull();
    expect(container.querySelector('.thinking-tool')).toBeNull();
  });

  it('keeps a failure in view, and says a machine payload in words', () => {
    renderLive([
      {
        kind: 'tool',
        tool: {
          name: 'convert_document',
          durationMs: 40,
          success: false,
          projectId: 'bakery',
          errorMessage:
            '{"version":1,"kind":"error","result":null,"error":{"code":"invalid-artifact-reference"}}',
        },
      },
    ]);

    expect(screen.getByText(/didn't finish\. Details has the full response\./)).toBeInTheDocument();
    expect(screen.queryByText(/invalid-artifact-reference/)).not.toBeInTheDocument();
  });

  it('shows the rows behind Details', () => {
    const { container } = renderLive(WORKING);

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(container.querySelector('.msg-stream-reasoning')).not.toBeNull();
    expect(container.querySelector('.thinking-tool')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Hide details' })).toBeInTheDocument();
  });

  it('offers no Details key when there is nothing behind it', () => {
    renderLive([{ kind: 'text', content: 'Hello!' }]);
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });
});

describe('StreamingBubble in debug mode', () => {
  it('shows the machine room as it happens, with no Details key', () => {
    const { container } = renderLive(WORKING, { debugMode: true });

    expect(container.querySelector('.msg-stream-reasoning')).not.toBeNull();
    expect(container.querySelector('.thinking-tool')).not.toBeNull();
    expect(container.querySelector('.msg-role')).toHaveTextContent('1 tool');
    expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });
});

describe('ToolHistoryExpando with steps folded', () => {
  // Audio played only inside the step list, so a folded reply lost it.
  it('lifts audio into view while the steps are hidden', () => {
    const { container } = render(
      <ToolHistoryExpando
        projectId="bakery"
        showSteps={false}
        tools={[
          {
            name: 'generate_speech',
            durationMs: 900,
            success: true,
            audios: [{ path: 'audio/note.wav', mimeType: 'audio/wav' }],
          },
        ]}
      />,
    );
    expect(container.querySelector('.msg-tool-media .thinking-tool-audios')).not.toBeNull();
  });

  it('keeps audio in the step list when the steps show', () => {
    const { container } = render(
      <ToolHistoryExpando
        projectId="bakery"
        tools={[
          {
            name: 'generate_speech',
            durationMs: 900,
            success: true,
            audios: [{ path: 'audio/note.wav', mimeType: 'audio/wav' }],
          },
        ]}
      />,
    );
    expect(container.querySelector('.msg-tool-media .thinking-tool-audios')).toBeNull();
  });
});

describe('isMachinePayload', () => {
  it('recognizes JSON envelopes and stack traces, not sentences', () => {
    expect(isMachinePayload('{"kind":"error"}')).toBe(true);
    expect(isMachinePayload('[{"x":1}]')).toBe(true);
    expect(isMachinePayload('TypeError: x\n    at render (file.js:1:2)')).toBe(true);
    expect(isMachinePayload('The gate wanted three slides, and got two.')).toBe(false);
  });
});
