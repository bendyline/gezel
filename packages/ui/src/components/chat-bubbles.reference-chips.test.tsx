import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));

const { MessageBubble } = await import('./chat-bubbles.js');

const pdf = { kind: 'artifact' as const, path: 'tasks/2/report.pdf' };
const draft = { kind: 'workspace' as const, path: 'pdf/task-2/report.md' };

/**
 * The reply footer outside debug mode. A finished invoice closed on its card
 * and then "Files: report.pdf report.md outline.md" and "Tasks:
 * sweet-rise-bakery-invoices/2" under it: the drafts beside the deliverable,
 * and a task's id where the card already opens the task.
 */
describe('MessageBubble reference chips', () => {
  it('drops the file list under a wrap-up that shows its finished card', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        synthetic="task-wrapup"
        content="All done — the invoice is finished."
        authorLabel="Dejan"
        authorIcon={null}
        projectId="bakery"
        referencedFiles={[pdf, draft]}
        deliverable={{ ...pdf, bytes: 13_200, modifiedAt: '2026-10-23T14:59:37.000Z' }}
      />,
    );
    expect(screen.queryByText('Files:')).not.toBeInTheDocument();
  });

  it('keeps the file list under a wrap-up in debug mode', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        synthetic="task-wrapup"
        content="All done — the invoice is finished."
        authorLabel="Dejan"
        authorIcon={null}
        projectId="bakery"
        debugMode
        referencedFiles={[pdf, draft]}
        deliverable={{ ...pdf, bytes: 13_200, modifiedAt: '2026-10-23T14:59:37.000Z' }}
      />,
    );
    expect(screen.getByText('Files:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'report.md' })).toBeInTheDocument();
  });

  it('keeps the file list on an ordinary reply that names files', () => {
    render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="I updated the outline."
        authorLabel="Dejan"
        authorIcon={null}
        projectId="bakery"
        referencedFiles={[draft]}
      />,
    );
    expect(screen.getByText('Files:')).toBeInTheDocument();
  });

  it('names task ids only in debug mode', () => {
    const { rerender } = render(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="On it — the invoice is underway."
        authorLabel="Dejan"
        authorIcon={null}
        projectId="bakery"
        referencedTasks={['sweet-rise-bakery-invoices/2']}
      />,
    );
    expect(screen.queryByText('Tasks:')).not.toBeInTheDocument();
    expect(screen.queryByText('sweet-rise-bakery-invoices/2')).not.toBeInTheDocument();

    rerender(
      // biome-ignore lint/a11y/useValidAriaRole: MessageBubble's domain role selects the message author; it is not forwarded as an ARIA role.
      <MessageBubble
        role="assistant"
        content="On it — the invoice is underway."
        authorLabel="Dejan"
        authorIcon={null}
        projectId="bakery"
        debugMode
        referencedTasks={['sweet-rise-bakery-invoices/2']}
      />,
    );
    expect(screen.getByText('Tasks:')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'sweet-rise-bakery-invoices/2' }),
    ).toBeInTheDocument();
  });
});
