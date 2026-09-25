import type { PromptDraftTaskLaunch, TurnIntentPlan } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  type LaunchReadiness,
  type SuppressedSuggestion,
  launchReadiness,
  mergeSuggestedLaunch,
  uploadStagingIds,
} from './composer-task-launch.js';
import { type CraftbookCatalogArt, useCraftbookCatalogArt } from './craftbook-catalog-art.js';
import type { PromptDraftController } from './usePromptDraft.js';

/**
 * The composer's attached task: the craftbook launch that Send will turn
 * into a task instead of a chat turn. Owns the in-memory attachment, keeps
 * it on the prompt draft (so it survives a restart and shows in the thread
 * picker), folds in the daemon's route suggestions, and re-checks uploaded
 * inputs whose staging may have been swept.
 *
 * Two rules the merge keeps: a person's own pick is never overwritten by a
 * suggestion, and a suggestion the person dismissed stays dismissed for
 * that text — in memory only, which is enough; a restart is a fresh look.
 */
export interface UseComposerTaskLaunchOptions {
  enabled: boolean;
  projectId: string;
  draft: PromptDraftController;
  getText: () => string;
  /** The live daemon route preview for the current text. */
  plan: TurnIntentPlan | null;
  /** The text the plan was computed for (suppression is keyed on it). */
  planText: string;
}

export interface ComposerTaskLaunchController {
  attached: PromptDraftTaskLaunch | null;
  art: CraftbookCatalogArt | null;
  readiness: LaunchReadiness;
  /** Upload inputs whose staging area is gone; the person re-picks them. */
  stale: string[];
  attach: (launch: PromptDraftTaskLaunch) => Promise<void>;
  dismiss: () => Promise<void>;
  /** The launch went out; forget it locally (the sent draft keeps the record). */
  clearAfterSend: () => void;
  /** The person dismissed the suggestion the daemon would make for this text. */
  dismissedForText: (text: string) => boolean;
}

export function useComposerTaskLaunch(
  options: UseComposerTaskLaunchOptions,
): ComposerTaskLaunchController {
  const { enabled, projectId, draft, getText, plan, planText } = options;
  const [attached, setAttached] = useState<PromptDraftTaskLaunch | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const attachedRef = useRef<PromptDraftTaskLaunch | null>(null);
  attachedRef.current = attached;
  const suppressedRef = useRef<SuppressedSuggestion | null>(null);
  const hydratedDraftIdRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const getTextRef = useRef(getText);
  getTextRef.current = getText;

  const art = useCraftbookCatalogArt(projectId, enabled ? (attached?.craftbookId ?? null) : null);
  // The suggested book's manifest is fetched as soon as the plan names it,
  // one pass before it becomes the attachment — so either fetch may be the
  // one that already holds the book readiness has to judge.
  const suggestionArt = useCraftbookCatalogArt(
    projectId,
    enabled && plan?.visible && plan.route === 'craftbook' ? (plan.craftbook?.id ?? null) : null,
  );
  const resolvedArt =
    [art, suggestionArt].find(
      (candidate) => candidate && attached && candidate.manifest.id === attached.craftbookId,
    ) ?? null;
  const manifest = resolvedArt?.manifest ?? null;

  // Hydrate from the draft only when a different draft arrives: a PATCH
  // round-trip echoing our own write must never repaint over a newer edit.
  useEffect(() => {
    if (!enabled) return;
    const id = draft.draftId;
    if (id === hydratedDraftIdRef.current) return;
    if (id === null) {
      // The draft went away (sent, discarded, or the thread changed under
      // it). Whatever we held belonged to it.
      hydratedDraftIdRef.current = null;
      if (attachedRef.current) setAttached(null);
      setStale([]);
      return;
    }
    if (!draft.meta || draft.meta.id !== id) return;
    hydratedDraftIdRef.current = id;
    setAttached(draft.meta.taskLaunch ?? null);
    setStale([]);
  }, [enabled, draft.draftId, draft.meta]);

  const persist = useCallback(async (launch: PromptDraftTaskLaunch | null): Promise<void> => {
    const controller = draftRef.current;
    controller.noteTaskLaunch(launch !== null);
    if (launch) {
      // Attaching is what brings a draft into being when the composer is
      // still empty — `update()` alone never creates one for no words.
      const id = await controller.ensureDraft();
      hydratedDraftIdRef.current = id;
    } else if (!controller.draftId) {
      return;
    }
    await controller.patchMeta({ taskLaunch: launch });
  }, []);

  const attach = useCallback(
    async (launch: PromptDraftTaskLaunch) => {
      const previous = attachedRef.current;
      setAttached(launch);
      setStale([]);
      const keep = new Set(uploadStagingIds(launch));
      for (const stagingId of uploadStagingIds(previous)) {
        if (!keep.has(stagingId))
          void api.taskInputs.deleteInputStaging(projectId, stagingId).catch(() => {});
      }
      try {
        await persist(launch);
      } catch {
        // The attachment is on screen and Send reads it from state; the
        // next PATCH (a later attach or dismiss) carries it again.
      }
    },
    [persist, projectId],
  );

  const dismiss = useCallback(async () => {
    const previous = attachedRef.current;
    if (!previous) return;
    if (previous.origin === 'suggested') {
      suppressedRef.current = {
        craftbookId: previous.craftbookId,
        text: getTextRef.current().trim(),
      };
    }
    setAttached(null);
    setStale([]);
    for (const stagingId of uploadStagingIds(previous)) {
      void api.taskInputs.deleteInputStaging(projectId, stagingId).catch(() => {});
    }
    try {
      await persist(null);
    } catch {
      /* the draft may already be gone */
    }
    const controller = draftRef.current;
    if (controller.draftId && !getTextRef.current().trim() && !controller.meta?.hasFiles) {
      await controller.discard();
    }
  }, [persist, projectId]);

  const clearAfterSend = useCallback(() => {
    hydratedDraftIdRef.current = null;
    setAttached(null);
    setStale([]);
    suppressedRef.current = null;
  }, []);

  const dismissedForText = useCallback((text: string): boolean => {
    const suppressed = suppressedRef.current;
    return suppressed !== null && suppressed.text === text.trim();
  }, []);

  // Fold the daemon's suggestion in once its book's manifest is known.
  useEffect(() => {
    if (!enabled) return;
    // A plan only means something for the text it was computed on. With the
    // composer emptied (a send, a discard) the plan is stale until the
    // preview effect clears it, and must not resurrect a suggestion.
    const next = mergeSuggestedLaunch({
      current: attachedRef.current,
      plan: planText.trim() ? plan : null,
      text: planText,
      suppressed: suppressedRef.current,
      manifest: suggestionArt?.manifest ?? manifest,
    });
    if (next === attachedRef.current) return;
    setAttached(next);
    void persist(next).catch(() => {});
  }, [enabled, plan, planText, suggestionArt, manifest, persist]);

  // An upload's staging area lives a day. Re-preview each one on hydrate so
  // a stale pick says so before Send finds out.
  useEffect(() => {
    if (!enabled || !attached?.inputs) return;
    const uploads = Object.entries(attached.inputs).filter(
      ([, source]) => source.from === 'upload',
    );
    if (uploads.length === 0) return;
    let cancelled = false;
    void (async () => {
      const gone: string[] = [];
      for (const [param, source] of uploads) {
        try {
          const preview = await api.taskInputs.previewTaskInput(projectId, {
            craftbookId: attached.craftbookId,
            param,
            source,
          });
          if (preview.error) gone.push(param);
        } catch (err) {
          if (err instanceof GezelApiError && err.status >= 400 && err.status < 500)
            gone.push(param);
        }
      }
      if (cancelled || gone.length === 0) return;
      const current = attachedRef.current;
      if (!current?.inputs) return;
      const inputs = Object.fromEntries(
        Object.entries(current.inputs).filter(([key]) => !gone.includes(key)),
      );
      const inputLabels = current.inputLabels
        ? Object.fromEntries(
            Object.entries(current.inputLabels).filter(([key]) => !gone.includes(key)),
          )
        : undefined;
      const { inputs: _i, inputLabels: _l, ...rest } = current;
      const next: PromptDraftTaskLaunch = {
        ...rest,
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        ...(inputLabels && Object.keys(inputLabels).length > 0 ? { inputLabels } : {}),
      };
      setStale(gone);
      setAttached(next);
      void persist(next).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the attachment identity: a re-preview per keystroke would be
    // a request per keystroke.
  }, [enabled, projectId, attached, persist]);

  const readiness = useMemo<LaunchReadiness>(
    () => (attached ? launchReadiness(attached, manifest) : { ready: true }),
    [attached, manifest],
  );

  return {
    attached: enabled ? attached : null,
    art: resolvedArt,
    readiness,
    stale,
    attach,
    dismiss,
    clearAfterSend,
    dismissedForText,
  };
}
