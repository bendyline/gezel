/**
 * Which installed video model renders a request that names none.
 *
 * One answer for every place that has to agree: the generate route, the
 * model list the Settings page and the composer read, and the chat path
 * that animates an attached picture. A picture to animate needs a model
 * that can animate it, and a model made only for animating pictures must
 * never be handed words alone.
 *
 * Unlike images, the person's own default wins over a specialist when it
 * can do the job: video models differ by tens of gigabytes and minutes per
 * clip, so the one they chose is the one they meant.
 *
 * Pure and browser-safe.
 */

export interface VideoModelChoiceCandidate {
  id: string;
  /** Animates a picture it is given. Absent: it makes clips from words only. */
  supportsImageToVideo?: boolean | undefined;
  /** Only animates pictures; given none, it has nothing to start from. */
  imageToVideoOnly?: boolean | undefined;
}

export interface VideoModelChoiceOptions {
  /** The person's configured default, when it is installed. */
  defaultModelId?: string | undefined;
  /** The request carries a picture to animate. */
  hasSource: boolean;
}

/** A model whose clips carry sound: LTX-2's audio branch, by load flag or an sd.cpp audio decoder slot. */
export function videoManifestHasAudio(manifest: {
  load?: { audio?: boolean | undefined } | undefined;
  source?: { files?: ReadonlyArray<{ role?: string | undefined } | undefined> } | undefined;
}): boolean {
  return (
    manifest.load?.audio === true ||
    (manifest.source?.files ?? []).some((f) => f?.role === 'audio_vae')
  );
}

export function videoModelAnimates(model: VideoModelChoiceCandidate): boolean {
  return model.supportsImageToVideo === true || model.imageToVideoOnly === true;
}

/**
 * A clip from words: the default unless it only animates, else the first
 * model that makes clips from words. A picture to animate: the default if
 * it animates, then a model made only for animating, then any that
 * animates. When nothing here animates, a model that makes clips from words
 * renders and the route reports that it left the picture out.
 */
export function chooseVideoModel(
  models: readonly VideoModelChoiceCandidate[],
  opts: VideoModelChoiceOptions,
): string | undefined {
  const preferred = opts.defaultModelId
    ? models.find((m) => m.id === opts.defaultModelId)
    : undefined;
  const fromWords = (m: VideoModelChoiceCandidate) => m.imageToVideoOnly !== true;
  const firstFromWords = () =>
    preferred && fromWords(preferred) ? preferred.id : models.find(fromWords)?.id;
  if (!opts.hasSource) return firstFromWords();
  const ranked = [
    ...(preferred && videoModelAnimates(preferred) ? [preferred] : []),
    ...models.filter((m) => m.imageToVideoOnly === true),
    ...models.filter(videoModelAnimates),
  ];
  return ranked[0]?.id ?? firstFromWords();
}
