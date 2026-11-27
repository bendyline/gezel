/**
 * The notes a craftbook step's `authoring` declaration adds to its prompt, from one place:
 * Squisq's markdown dialect, or one of Molen's authoring documents (a film, a game, or a
 * data-only scene). The Molen primers are a snapshot of the ones Molen ships
 * (`scripts/snapshot-molen-primers.mjs`), so core takes no dependency on Molen.
 */

import type { CraftbookStepAuthoring } from '../schemas/craftbook.js';
import {
  MOLEN_FILM_PRIMER,
  MOLEN_GAME_PRIMER,
  MOLEN_SCENE_PRIMER,
} from './molen-primers.generated.js';
import { squisqAuthoringNote } from './squisq-dialect.js';

/**
 * A primer ends by asking for the document as a reply; a step writes it to a file instead, and
 * the step's procedure says which file and what the film, game or scene is about.
 */
function asStepNote(primer: string, what: string): string {
  const body = primer.replace(/\n*Reply with the JSON only[^\n]*\n*$/, '').trimEnd();
  return `${body}\n\nWrite the ${what} as one JSON document in the file the step's procedure names. The procedure decides what it shows; where the procedure differs from these notes, follow the procedure. A primer example shows the shape only: never copy its story.`;
}

/** The note for a step that declares `authoring`. */
export function authoringNote(kind: CraftbookStepAuthoring): string {
  switch (kind) {
    case 'squisq':
    case 'squisq-slideshow':
      return squisqAuthoringNote(kind);
    case 'molen-film':
      return asStepNote(MOLEN_FILM_PRIMER, 'film');
    case 'molen-game':
      return asStepNote(MOLEN_GAME_PRIMER, 'game');
    case 'molen-scene':
      return asStepNote(MOLEN_SCENE_PRIMER, 'scene');
  }
}
