import type { ReferencedFile } from '@bendyline/gezel';
import { createContext } from 'react';

/**
 * How a finished-work card reaches the pane beside its conversation
 * (`ChatReferences` provides it). The file a person asked for gets the stage:
 * it becomes the file the pane shows when it arrives, and opening it from its
 * card widens the pane to reading size. A path linked inside a message does
 * neither; it is one file among many.
 */
export interface ResultStage {
  /** A finished deliverable is on screen in this conversation. */
  present(file: ReferencedFile, projectId: string, modifiedAt?: string): void;
  /** Run a card's Open so the pane knows the file came from the card. */
  openFromCard(open: () => void): void;
}

export const ResultStageContext = createContext<ResultStage | null>(null);
