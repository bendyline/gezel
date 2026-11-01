/**
 * Which installed LoRAs a render uses: the model's fast mode, unless the
 * person turned it off or asked for more steps than it renders in, and the
 * style the person or a gezel named. A style that does not match never fails
 * the render; the notes say which styles the model has instead.
 *
 * Pure and browser-safe.
 */

export interface ImageLoraCandidate {
  id: string;
  name: string;
  purpose: 'style' | 'speed';
  /** The steps a speed LoRA renders in. */
  steps?: number;
}

export interface ImageLoraChoiceOptions {
  /** A style's id or name; empty or absent for none. */
  style?: string | undefined;
  /** Whether fast mode is wanted (the person's setting, or the request's). */
  fast: boolean;
  /** Steps the caller asked for explicitly, when it did. */
  askedSteps?: number | undefined;
}

export interface ImageLoraChoice {
  /** The fast mode first, then the style. */
  loras: ImageLoraCandidate[];
  notes: string[];
  /** The styles the model has, for a caller that cannot read the model list. */
  styles: Array<{ id: string; name: string }>;
}

export function chooseImageLoras(
  available: readonly ImageLoraCandidate[],
  opts: ImageLoraChoiceOptions,
): ImageLoraChoice {
  const styles = available.filter((l) => l.purpose === 'style');
  const loras: ImageLoraCandidate[] = [];
  const notes: string[] = [];

  const speed = opts.fast ? available.find((l) => l.purpose === 'speed') : undefined;
  if (speed) {
    if (
      opts.askedSteps !== undefined &&
      speed.steps !== undefined &&
      opts.askedSteps > speed.steps
    ) {
      notes.push(`Fast mode was left off for the ${opts.askedSteps} steps asked.`);
    } else {
      loras.push(speed);
    }
  }

  const asked = opts.style?.trim();
  if (asked) {
    const style = matchStyle(styles, asked);
    if (style) {
      loras.push(style);
    } else {
      notes.push(
        styles.length > 0
          ? `No "${asked}" style for this model, so it was drawn without one. Its styles: ${styles.map((s) => s.name).join(', ')}.`
          : `This model has no styles installed, so "${asked}" was left out.`,
      );
    }
  }

  return { loras, notes, styles: styles.map(({ id, name }) => ({ id, name })) };
}

/** By id, then by name, then by the one name that contains the words asked. */
function matchStyle(
  styles: readonly ImageLoraCandidate[],
  asked: string,
): ImageLoraCandidate | undefined {
  const lower = asked.toLowerCase();
  const byId = styles.find((s) => s.id === asked);
  if (byId) return byId;
  const byName = styles.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName;
  const containing = styles.filter((s) => s.name.toLowerCase().includes(lower));
  return containing.length === 1 ? containing[0] : undefined;
}
