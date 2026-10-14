import type { PromptDraftTaskLaunch, TurnIntentPlan } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  type LaunchReadiness,
  type PickableInput,
  type SuppressedSuggestion,
  launchReadiness,
  mergeSuggestedLaunch,
  pickableInputs,
  uploadStagingIds,
  withPickedInput,
} from './composer-task-launch.js';
import {
  type CraftbookCatalogArt,
  useCraftbookCatalogArt,
  useCraftbookCatalogLookup,
} from './craftbook-catalog-art.js';
import type { PickedSet } from './craftbook-input/pick-files.js';
import { stageInputUpload } from './craftbook-input/stage-upload.js';
import type { PromptDraftController } from './usePromptDraft.js';

/**
 * The composer's attached task: the craftbook launch that Send will turn
 * into a task instead of a chat turn. Owns the in-memory attachment, keeps
 * it on the prompt draft (so it survives a restart and shows in the thread
 * picker), folds in the daemon's route suggestions, and re-checks uploaded
 * inputs whose staging may have been swept.
 *
 * Two rules the merge keeps: a person's own pick is never overwritten by a
 * suggestion, and a suggestion the person dismissed stays dismissed while
 * they keep writing — until the composer is emptied or the message goes out.
 * In memory only, which is enough; a restart is a fresh look.
 */
export interface UseComposerTaskLaunchOptions {
  enabled: boolean;
  projectId: string;
  draft: PromptDraftController;
  getText: () => string;
  /** The live daemon route preview for the current text. */
  plan: TurnIntentPlan | null;
  /** The composer's current text, which the plan was computed for. */
  planText: string;
}

/** A file the person is picking from the strip for one input. */
export interface InputPickState {
  key: string;
  /** Uploaded so far; absent while the staging area is being opened. */
  progress?: { done: number; total: number };
  /** The pick could not be used. Shown on the strip until the next pick. */
  error?: string;
}

export interface ComposerTaskLaunchController {
  attached: PromptDraftTaskLaunch | null;
  art: CraftbookCatalogArt | null;
  readiness: LaunchReadiness;
  /** Upload inputs whose staging area is gone; the person re-picks them. */
  stale: string[];
  /** Inputs the strip can fill from the person's computer. */
  pickable: PickableInput[];
  picking: InputPickState | null;
  /** Upload a pick for one input; it replaces the sample or fills the gap. */
  pickInput: (key: string, pick: PickedSet) => Promise<void>;
  attach: (launch: PromptDraftTaskLaunch) => Promise<void>;
  dismiss: () => Promise<void>;
  /** The launch went out; forget it locally (the sent draft keeps the record). */
  clearAfterSend: () => void;
  /** The person dismissed the task the daemon is suggesting for this message. */
  suggestionDismissed: () => boolean;
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
  const planRef = useRef(plan);
  planRef.current = plan;

  const lookup = useCraftbookCatalogLookup(
    projectId,
    enabled ? (attached?.craftbookId ?? null) : null,
  );
  const art = lookup.art;
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
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;
  const [picking, setPicking] = useState<InputPickState | null>(null);
  const pickAbortRef = useRef<AbortController | null>(null);

  const cancelPick = useCallback(() => {
    pickAbortRef.current?.abort();
    pickAbortRef.current = null;
    setPicking(null);
  }, []);

  useEffect(() => () => pickAbortRef.current?.abort(), []);

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
      cancelPick();
      return;
    }
    if (!draft.meta || draft.meta.id !== id) return;
    hydratedDraftIdRef.current = id;
    setAttached(draft.meta.taskLaunch ?? null);
    setStale([]);
    cancelPick();
  }, [enabled, draft.draftId, draft.meta, cancelPick]);

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
      setPicking((current) => (current?.error ? null : current));
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

  const pickInput = useCallback(
    async (key: string, pick: PickedSet) => {
      const launch = attachedRef.current;
      const book = manifestRef.current;
      if (!launch || !book) return;
      const target = pickableInputs(launch, book).find((p) => p.input.key === key);
      if (!target) return;
      pickAbortRef.current?.abort();
      const abort = new AbortController();
      pickAbortRef.current = abort;
      setPicking({ key });
      const value = await stageInputUpload({
        projectId,
        craftbookId: launch.craftbookId,
        input: target.input,
        pick,
        signal: abort.signal,
        onProgress: (progress) => {
          if (pickAbortRef.current === abort && progress.progress) {
            setPicking({ key, progress: progress.progress });
          }
        },
      });
      if (pickAbortRef.current !== abort || !value) return;
      pickAbortRef.current = null;
      const source = value.source;
      if (!source) {
        setPicking({ key, error: value.error ?? 'That file could not be used.' });
        return;
      }
      // Merge into the attachment as it is now (a Tonight toggle may have
      // landed mid-upload), unless the input is no longer the strip's to fill.
      const current = attachedRef.current;
      if (!current || !pickableInputs(current, book).some((p) => p.input.key === key)) {
        if (source.from === 'upload') {
          void api.taskInputs.deleteInputStaging(projectId, source.stagingId).catch(() => {});
        }
        setPicking(null);
        return;
      }
      setPicking(null);
      await attach(withPickedInput(current, key, { ...value, source }));
    },
    [projectId, attach],
  );

  const dismiss = useCallback(async () => {
    const previous = attachedRef.current;
    if (!previous) return;
    if (previous.origin === 'suggested') {
      suppressedRef.current = { craftbookId: previous.craftbookId };
    }
    cancelPick();
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
  }, [persist, projectId, cancelPick]);

  const clearAfterSend = useCallback(() => {
    hydratedDraftIdRef.current = null;
    setAttached(null);
    setStale([]);
    cancelPick();
    suppressedRef.current = null;
  }, [cancelPick]);

  const suggestionDismissed = useCallback((): boolean => {
    const suppressed = suppressedRef.current;
    if (!suppressed) return false;
    // Still the book that was turned down, or no newer plan to say otherwise.
    const suggested = planRef.current?.craftbook?.id;
    return suggested === undefined || suggested === suppressed.craftbookId;
  }, []);

  // An emptied composer is a new message: a dismissal does not outlive it.
  useEffect(() => {
    if (!planText.trim()) suppressedRef.current = null;
  }, [planText]);

  // Fold the daemon's suggestion in once its book's manifest is known.
  useEffect(() => {
    if (!enabled) return;
    // A plan only means something for the text it was computed on. With the
    // composer emptied (a send, a discard) the plan is stale until the
    // preview effect clears it, and must not resurrect a suggestion.
    const next = mergeSuggestedLaunch({
      current: attachedRef.current,
      plan: planText.trim() ? plan : null,
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

  const hasMessage = planText.trim().length > 0;
  const attachedMissing = lookup.status === 'missing' && resolvedArt === null;
  const uploading = picking !== null && !picking.error;
  const readiness = useMemo<LaunchReadiness>(() => {
    if (!attached) return { ready: true };
    // Send mid-upload would start the task on the sample the pick replaces.
    if (uploading) return { ready: false, reason: 'Wait for the file to finish uploading.' };
    return launchReadiness(attached, manifest, { hasMessage, missing: attachedMissing });
  }, [attached, manifest, hasMessage, attachedMissing, uploading]);
  const pickable = useMemo(
    () => (attached ? pickableInputs(attached, manifest) : []),
    [attached, manifest],
  );

  return {
    attached: enabled ? attached : null,
    art: resolvedArt,
    readiness,
    stale,
    pickable: enabled ? pickable : [],
    picking,
    pickInput,
    attach,
    dismiss,
    clearAfterSend,
    suggestionDismissed,
  };
}
