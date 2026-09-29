import { createContext } from 'react';

/**
 * True for content ChatComposer renders inside its editor toolbar. A narrow
 * composer moves the thread bar there to give the conversation back a row,
 * and SessionSwitcher reads this to draw its compact form.
 */
export const ComposerToolbarContext = createContext(false);
