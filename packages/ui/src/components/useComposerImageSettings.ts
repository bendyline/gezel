import {
  type ImageSettings,
  type ImageSizeSettings,
  type InstalledImageModel,
  type ParsedImageCues,
  parseImageSettingsFromText,
} from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { effectiveImageSettings, imageSendFields } from './composer-image-settings.js';
import type { PromptDraftController } from './usePromptDraft.js';

export interface UseComposerImageSettingsOptions {
  enabled: boolean;
  draft: PromptDraftController;
  /** The direct image gezel's stored `fixedFunction.defaults`. */
  defaults: Record<string, unknown> | undefined;
  /** The text in the composer now. */
  text: string;
}

export interface ComposerImageSettings {
  enabled: boolean;
  picks: ImageSettings;
  /** Settings read from the text, when the person has not dismissed them. */
  cues: ParsedImageCues | null;
  /** What the next render will use. */
  effective: ImageSizeSettings;
  model: InstalledImageModel | undefined;
  models: readonly InstalledImageModel[];
  /** Why High will not fit this model on this machine; null when it will. */
  highRefusal: string | null;
  pick: (patch: ImageSettings) => void;
  dismissCues: () => void;
  sendFields: (text: string) => { imageSettings?: ImageSettings; imageCues?: 'off' };
}

/**
 * State for the composer's image strip. Picks stay through a send — a person
 * making a set of phone wallpapers should not re-pick 9:16 for each one — and
 * ride on the open draft so they survive a restart. Settings read from the
 * text apply to that one message unless the person dismisses them or picks a
 * key, which is an explicit choice that wins.
 */
export function useComposerImageSettings({
  enabled,
  draft,
  defaults,
  text,
}: UseComposerImageSettingsOptions): ComposerImageSettings {
  const [picks, setPicks] = useState<ImageSettings>({});
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{
    models: InstalledImageModel[];
    defaultModel?: string;
  } | null>(null);
  const [highRefusals, setHighRefusals] = useState<Map<string, string>>(new Map());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hydratedDraftIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .listInstalledImageModels()
      .then((res) => {
        if (!cancelled) setCatalog(res);
      })
      .catch(() => {});
    api
      .getImageModelFit({ quality: 'high' })
      .then((res) => {
        if (cancelled) return;
        setHighRefusals(
          new Map(res.models.filter((m) => m.verdict === 'wont-run').map((m) => [m.id, m.reason])),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Adopt the picks a draft carries when a different draft opens; a new
  // draft with none takes the current picks, which is what keeps them
  // through a send.
  useEffect(() => {
    if (!enabled) return;
    const id = draft.draftId;
    if (!id || id === hydratedDraftIdRef.current) return;
    if (!draft.meta || draft.meta.id !== id) return;
    hydratedDraftIdRef.current = id;
    if (draft.meta.imageSettings) setPicks(draft.meta.imageSettings);
    else if (Object.keys(picksRef.current).length > 0)
      void draft.patchMeta({ imageSettings: picksRef.current }).catch(() => {});
  }, [enabled, draft.draftId, draft.meta, draft]);

  const trimmed = text.trim();
  const parsed = useMemo(
    () => (enabled && trimmed ? parseImageSettingsFromText(trimmed) : null),
    [enabled, trimmed],
  );
  const cues = parsed && parsed.cues.length > 0 && dismissedFor !== trimmed ? parsed : null;
  const effective = useMemo(
    () => effectiveImageSettings({ defaults, picks, cues: cues?.settings }),
    [defaults, picks, cues],
  );
  const modelId = effective.model ?? catalog?.defaultModel ?? catalog?.models[0]?.id;
  const model = catalog?.models.find((m) => m.id === modelId);

  const pick = useCallback(
    (patch: ImageSettings) => {
      const next: ImageSettings = { ...picksRef.current, ...patch };
      for (const key of Object.keys(next) as Array<keyof ImageSettings>) {
        if (next[key] === undefined) delete next[key];
      }
      setPicks(next);
      // A key pressed while the text names a setting is the person's answer.
      if (parsed && parsed.cues.length > 0) setDismissedFor(trimmed);
      const controller = draftRef.current;
      if (controller.draftId) {
        void controller
          .patchMeta({ imageSettings: Object.keys(next).length > 0 ? next : null })
          .catch(() => {});
      }
    },
    [parsed, trimmed],
  );

  const dismissCues = useCallback(() => setDismissedFor(trimmed), [trimmed]);

  const sendFields = useCallback(
    (sentText: string) =>
      imageSendFields({
        picks: picksRef.current,
        cuesDismissed: dismissedFor !== null && dismissedFor === sentText.trim(),
      }),
    [dismissedFor],
  );

  return {
    enabled,
    picks,
    cues,
    effective,
    model,
    models: catalog?.models ?? [],
    highRefusal: model ? (highRefusals.get(model.id) ?? null) : null,
    pick,
    dismissCues,
    sendFields,
  };
}
