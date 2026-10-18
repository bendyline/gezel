import type { SuggestWorkResult } from '../schemas/work-options.js';

/**
 * Presentation variants of a work-options list, for the stage-2 ablations of
 * the pre-ranked note (`prompt.work-options-*` markers). Each strips one
 * thing the default list carries, so an A/B can tell whether it earns its
 * tokens: the guidance lines ("answer in chat yourself…"), or every option
 * after the first. Numbering the options instead of naming their ids is a
 * rendering choice (`renderSuggestWorkResult`'s `ordinalIds`), since the ids
 * are what `start_work` binds.
 */
export interface WorkOptionsShape {
  /** Drop the guidance verdicts (self, ask, specialist, author). */
  noGuidance?: boolean;
  /** Keep at most this many options. */
  maxOptions?: number;
}

export function shapeWorkOptions(
  result: SuggestWorkResult,
  shape: WorkOptionsShape,
): SuggestWorkResult {
  return {
    ...result,
    options:
      shape.maxOptions !== undefined
        ? result.options.slice(0, Math.max(1, shape.maxOptions))
        : result.options,
    guidance: shape.noGuidance ? [] : result.guidance,
  };
}

/** A list position ("1", "2", …) given where an option id was asked for. */
export function isOrdinalWorkOptionId(id: string): boolean {
  return /^[1-9]\d?$/.test(id.trim());
}
