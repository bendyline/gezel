import type { ReferencedFile } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskOutputsList } from './TaskOutputsList.js';

const artifact = (path: string): ReferencedFile => ({ kind: 'artifact', path });
const workspace = (path: string): ReferencedFile => ({ kind: 'workspace', path });

describe('TaskOutputsList', () => {
  it('lists every file besides the deliverable, and opens one', () => {
    const deck = workspace('pdf/task-12/report.pdf');
    render(
      <TaskOutputsList
        projectId="trip"
        outputs={[deck, artifact('tasks/12/outline.md'), workspace('pdf/task-12/report.md')]}
        deliverable={deck}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Other files' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /report\.pdf/ })).toBeNull();
    expect(screen.getByRole('button', { name: /report\.md/ })).toHaveTextContent(
      'report.mdProject folder · pdf/task-12',
    );

    const opened: unknown[] = [];
    const record = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener('gezel:open-file', record);
    fireEvent.click(screen.getByRole('button', { name: /outline\.md/ }));
    window.removeEventListener('gezel:open-file', record);
    expect(opened).toEqual([
      { projectId: 'trip', path: 'tasks/12/outline.md', source: 'artifacts' },
    ]);
  });

  it('folds a long list until asked', () => {
    const outputs = Array.from({ length: 11 }, (_, i) => artifact(`tasks/3/part-${i}.md`));
    render(<TaskOutputsList projectId="default" outputs={outputs} deliverable={null} />);

    expect(screen.getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 11' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(11);
  });

  it('renders nothing when the deliverable is all the task made', () => {
    const deck = artifact('tasks/1/deck.pptx');
    const { container } = render(
      <TaskOutputsList projectId="default" outputs={[deck]} deliverable={deck} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
