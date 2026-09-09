import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

type EditableContextMenuParams = Pick<
  ContextMenuParams,
  | 'dictionarySuggestions'
  | 'editFlags'
  | 'hasImageContents'
  | 'isEditable'
  | 'mediaType'
  | 'misspelledWord'
  | 'x'
  | 'y'
>;

export interface EditableContextMenuActions {
  addToDictionary(word: string): void;
  copyImageAt(x: number, y: number): void;
  replaceMisspelling(suggestion: string): void;
}

/**
 * Build the native menu for editable surfaces and images.
 *
 * Chromium performs the spellcheck in the renderer, but Electron deliberately
 * leaves presentation of its suggestions to the host application. Keeping the
 * template here makes that host responsibility apply equally to Squisq,
 * ordinary inputs, and any future contenteditable surface. Chromium also
 * exposes the decoded bitmap under an image context, which lets the same native
 * menu copy an inline editor image without involving that editor's document
 * model or storage provider.
 */
export function buildEditableContextMenuTemplate(
  params: EditableContextMenuParams,
  actions: EditableContextMenuActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (params.mediaType === 'image' && params.hasImageContents) {
    template.push({
      label: 'Copy Image',
      click: () => actions.copyImageAt(params.x, params.y),
    });
  }

  if (!params.isEditable) return template;

  if (template.length > 0) template.push({ type: 'separator' });
  const misspelledWord = params.misspelledWord.trim();

  if (misspelledWord) {
    const suggestions = [...new Set(params.dictionarySuggestions.filter(Boolean))];
    if (suggestions.length > 0) {
      template.push(
        ...suggestions.map((suggestion) => ({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        })),
      );
    } else {
      template.push({ label: 'No spelling suggestions', enabled: false });
    }

    template.push(
      { type: 'separator' },
      {
        label: `Add “${misspelledWord}” to dictionary`,
        click: () => actions.addToDictionary(misspelledWord),
      },
      { type: 'separator' },
    );
  }

  template.push(
    { role: 'undo', enabled: params.editFlags.canUndo },
    { role: 'redo', enabled: params.editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { role: 'delete', enabled: params.editFlags.canDelete },
    { type: 'separator' },
    { role: 'selectAll', enabled: params.editFlags.canSelectAll },
  );

  return template;
}
