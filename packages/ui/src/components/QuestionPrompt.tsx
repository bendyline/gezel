import type { Question } from '@bendyline/gezel';
import { type MouseEvent, createContext, useContext, useMemo } from 'react';
import { RenderedMarkdown } from './chat-bubbles.js';
import { fileRefFromHref, linkifyFileRefs } from './file-linkify.js';
import { openProjectFileActions, runNavActions } from './nav-actions.js';

/**
 * Called after a question card opens something (a file, its task, its
 * document) so a host that floats over the app, like Activity, can step aside
 * for what the person opened. A host that is the page itself provides nothing.
 */
export const CardNavigation = createContext<(() => void) | undefined>(undefined);

/**
 * A question's prompt, with every file it names that the daemon verified
 * turned into a link that opens the file: the same promotion chat replies and
 * task notes get. A file in another project opens in its own, which is how a
 * task-finished card filed in the wrap-up thread's project opens the task's
 * files.
 */
export function QuestionPrompt({ question, id }: { question: Question; id?: string }) {
  const onNavigate = useContext(CardNavigation);
  const files = question.referencedFiles;
  const markdown = useMemo(
    () => (files?.length ? linkifyFileRefs(question.prompt, files) : question.prompt),
    [question.prompt, files],
  );
  const openFile = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    const file = anchor ? fileRefFromHref(anchor.getAttribute('href') ?? '') : null;
    if (!file) return;
    e.preventDefault();
    const owner =
      files?.find((f) => f.kind === file.kind && f.path === file.path)?.projectId ??
      question.projectId;
    runNavActions(
      openProjectFileActions({
        projectId: owner,
        path: file.path,
        source: file.kind === 'workspace' ? 'workspace' : 'artifacts',
        fromQuestion: true,
      }),
    );
    onNavigate?.();
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: event delegation to child <a>
    <div className="pending-question-prompt" id={id} onClick={openFile}>
      <RenderedMarkdown markdown={markdown} />
    </div>
  );
}
