import type { FixedFunctionConfig } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * For a fixed-function *generator* gezel (one that forwards chat messages
 * to `generate_video` / `generate_image`), the chat-model engine label
 * ("This Mac (qwen3.6-…)") is meaningless — no LLM runs. This resolves the
 * actual generation model instead, e.g. "Video · ltx-video-0.9.7", for the
 * session-switcher row.
 *
 * The installed-model endpoints already resolve a server-side `defaultModel`
 * (the one a call with no explicit model would use), so we just surface that.
 * Non-generative fixed-function tools (and ordinary LLM gezels) return null —
 * callers fall back to the normal provider+model label.
 */
type GenSpec = {
  kind: string;
  list: () => Promise<{ models: { id: string; name: string }[]; defaultModel?: string }>;
};

function genSpec(tool: string): GenSpec | null {
  switch (tool) {
    case 'generate_video':
      return { kind: 'Video', list: () => api.listInstalledVideoModels() };
    case 'generate_image':
      return { kind: 'Image', list: () => api.listInstalledImageModels() };
    default:
      return null;
  }
}

export function useGenerationEngineLabel(
  fixedFunction: FixedFunctionConfig | undefined,
): string | null {
  const tool = fixedFunction?.tool;
  // A gezel-pinned model override (rare — most generators ride the engine
  // default), e.g. `fixedFunction.defaults.model`.
  const pinned =
    typeof fixedFunction?.defaults?.model === 'string' ? fixedFunction.defaults.model : undefined;
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!tool) {
      setLabel(null);
      return;
    }
    const spec = genSpec(tool);
    if (!spec) {
      setLabel(null);
      return;
    }
    // Show the engine kind right away; refine with the model once it loads.
    setLabel(pinned ? `${spec.kind} · ${pinned}` : `${spec.kind} generator`);
    if (pinned) return;

    let cancelled = false;
    spec
      .list()
      .then((res) => {
        if (cancelled) return;
        const id = res.defaultModel ?? res.models[0]?.id;
        const name = res.models.find((m) => m.id === id)?.name ?? id;
        setLabel(name ? `${spec.kind} · ${name}` : `${spec.kind} generator`);
      })
      .catch(() => {
        /* keep the kind-only label */
      });
    return () => {
      cancelled = true;
    };
  }, [tool, pinned]);

  return label;
}
