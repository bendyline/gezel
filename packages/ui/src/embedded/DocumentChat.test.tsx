import type { GezelSummary } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  timeline: [] as Array<Record<string, unknown>>,
  composer: [] as Array<Record<string, unknown>>,
  switcher: [] as Array<Record<string, unknown>>,
}));

vi.mock('../components/ChatComposer.js', () => ({
  ChatComposer: (props: Record<string, unknown> & { placeholder?: string }) => {
    seen.composer.push(props);
    return (
      <div>
        {props.placeholder}
        {props.belowAddressLine as React.ReactNode}
      </div>
    );
  },
}));
vi.mock('../components/ProjectTimeline.js', () => ({
  ProjectTimeline: (props: Record<string, unknown>) => {
    seen.timeline.push(props);
    return <div data-testid="timeline" />;
  },
}));
vi.mock('../components/SessionSwitcher.js', () => ({
  SessionSwitcher: (props: Record<string, unknown>) => {
    seen.switcher.push(props);
    return <div data-testid="session-switcher" />;
  },
}));
vi.mock('../components/useRoleBasedNameOnlyMode.js', () => ({
  useRoleBasedNameOnlyMode: () => false,
}));
const MAREK = { id: 'marek', name: 'Marek', role: 'Copywriter' } as GezelSummary;
vi.mock('../api.js', () => ({
  api: { listGezels: async () => ({ gezels: [MAREK] }) },
}));

const { DocumentChat } = await import('./DocumentChat.js');

const SUBJECT = {
  key: 'surface:pane-12345',
  kind: 'document' as const,
  app: 'Word',
  title: 'Untitled document',
};

describe('DocumentChat', () => {
  it('scopes the conversation to the document and stamps new threads with it', async () => {
    const onShowProject = vi.fn();
    render(
      <DocumentChat
        projectId="default"
        gezelId="marek"
        subject={SUBJECT}
        subjectKeys={['surface:pane-12345']}
        onShowProject={onShowProject}
      />,
    );

    expect(await screen.findByText('Talk with Marek about this document.')).toBeInTheDocument();
    expect(screen.getByText('Untitled document')).toBeInTheDocument();
    expect(seen.timeline.at(-1)).toMatchObject({
      projectId: 'default',
      subjectKeys: ['surface:pane-12345'],
    });
    expect(seen.composer.at(-1)).toMatchObject({
      gezelId: 'marek',
      subject: SUBJECT,
      subjectKeys: ['surface:pane-12345'],
      draftScope: 'document:surface:pane-12345',
    });
    expect(seen.switcher.at(-1)).toMatchObject({ subjectKeys: ['surface:pane-12345'] });

    fireEvent.click(screen.getByRole('button', { name: 'Show project' }));
    expect(onShowProject).toHaveBeenCalled();
  });

  it('says so when the chosen gezel is gone', async () => {
    render(
      <DocumentChat
        projectId="default"
        gezelId="nobody"
        subject={SUBJECT}
        subjectKeys={[SUBJECT.key]}
        onShowProject={() => undefined}
      />,
    );
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
  });
});
