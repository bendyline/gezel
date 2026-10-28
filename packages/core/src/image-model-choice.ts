/**
 * Which installed image model renders a request that names none.
 *
 * One answer for every place that has to agree: the local engine's own
 * default, the generate route (which passes the choice on to the machine
 * broker or a paired server), and the model list the image strip reads. A
 * picture made to be changed needs a model that can change it, and a model
 * made only for changing pictures must never be handed a blank page.
 *
 * Pure and browser-safe.
 */

export interface ImageModelChoiceCandidate {
  id: string;
  /** How the model uses a source picture; absent when it cannot edit. */
  editMode?: 'reference' | 'img2img' | undefined;
  editOnly?: boolean | undefined;
}

export interface ImageModelChoiceOptions {
  /** The person's configured default, when it is installed. */
  defaultModelId?: string | undefined;
  /** The request carries source pictures to change. */
  hasSources: boolean;
}

/**
 * A fresh picture: the default unless it only edits, else the first model
 * that draws. An edit: a model made for editing first, since it follows an
 * instruction where a drawing model re-noises the source; then the default
 * if it reads references, then any model that does, then img2img the same
 * way. When nothing here edits, the default renders and the engine reports
 * that it dropped the sources, as it always has.
 */
export function chooseImageModel(
  models: readonly ImageModelChoiceCandidate[],
  opts: ImageModelChoiceOptions,
): string | undefined {
  const preferred = opts.defaultModelId
    ? models.find((m) => m.id === opts.defaultModelId)
    : undefined;
  const draws = (m: ImageModelChoiceCandidate) => !m.editOnly;
  if (!opts.hasSources) {
    if (preferred && draws(preferred)) return preferred.id;
    return models.find(draws)?.id;
  }
  const ranked = [
    ...models.filter((m) => m.editOnly && m.editMode === 'reference'),
    ...(preferred?.editMode === 'reference' ? [preferred] : []),
    ...models.filter((m) => m.editMode === 'reference'),
    ...(preferred?.editMode === 'img2img' ? [preferred] : []),
    ...models.filter((m) => m.editMode === 'img2img'),
  ];
  return ranked[0]?.id ?? (preferred && draws(preferred) ? preferred.id : models.find(draws)?.id);
}
