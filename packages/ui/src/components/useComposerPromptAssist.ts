import type { PromptAssistAction } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export interface UseComposerPromptAssistOptions {
  projectId: string;
  gezelId: string | undefined;
  /** The direct image gezel's model, for "Shape for <model>". */
  imageModelId?: string | undefined;
  getText: () => string;
  /** Put text in the composer as if the person had typed it. */
  replaceText: (text: string) => void;
  onError: (message: string) => void;
}

export interface ComposerPromptAssist {
  busy: PromptAssistAction | null;
  /** Suggestions from "Review my message", until applied or dismissed. */
  review: string[] | null;
  canUndo: boolean;
  /** A quiet note for an answer that changed nothing. */
  notice: string | null;
  run: (action: PromptAssistAction, notes?: readonly string[]) => Promise<void>;
  undo: () => void;
  dismissReview: () => void;
  /** The composer's text changed; an edit after a rewrite keeps the person's typing. */
  noteEdit: (text: string) => void;
}

function errorText(err: unknown): string {
  const details = (err as { details?: { error?: unknown } }).details;
  if (details && typeof details.error === 'string') return details.error;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The sparkle menu's state: one request at a time, the review suggestions,
 * and one level of undo for the last rewrite. A rewrite only ever lands in
 * the composer; the person still reads it and presses Send.
 */
export function useComposerPromptAssist({
  projectId,
  gezelId,
  imageModelId,
  getText,
  replaceText,
  onError,
}: UseComposerPromptAssistOptions): ComposerPromptAssist {
  const [busy, setBusy] = useState<PromptAssistAction | null>(null);
  const [review, setReview] = useState<string[] | null>(null);
  const [undoState, setUndoState] = useState<{ before: string; after: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const undoRef = useRef(undoState);
  undoRef.current = undoState;
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (action: PromptAssistAction, notes?: readonly string[]) => {
      const before = getText();
      const text = before.trim();
      if (!text) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(action);
      setNotice(null);
      try {
        const res = await api.promptAssist(
          projectId,
          {
            action,
            text,
            ...(gezelId ? { gezelId } : {}),
            ...(action === 'shape-image' && imageModelId ? { imageModel: imageModelId } : {}),
            ...(notes && notes.length > 0 ? { notes: [...notes] } : {}),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (res.suggestions) {
          setReview(res.suggestions);
        } else if (res.unchanged) {
          setNotice('Already reads well. Nothing changed.');
        } else if (res.text) {
          setUndoState({ before, after: res.text });
          setReview(null);
          replaceText(res.text);
        }
      } catch (err) {
        if (!controller.signal.aborted) onError(errorText(err));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(null);
        }
      }
    },
    [projectId, gezelId, imageModelId, getText, replaceText, onError],
  );

  const undo = useCallback(() => {
    const state = undoRef.current;
    if (!state) return;
    setUndoState(null);
    replaceText(state.before);
  }, [replaceText]);

  const noteEdit = useCallback((text: string) => {
    setNotice(null);
    const state = undoRef.current;
    if (state && text.trim() !== state.after.trim()) setUndoState(null);
  }, []);

  return {
    busy,
    review,
    canUndo: undoState !== null,
    notice,
    run,
    undo,
    dismissReview: useCallback(() => setReview(null), []),
    noteEdit,
  };
}
