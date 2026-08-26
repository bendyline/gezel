import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { buildEditableContextMenuTemplate } from './editable-context-menu.js';

const editFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: true,
};

function params(
  overrides: Partial<
    Pick<ContextMenuParams, 'dictionarySuggestions' | 'editFlags' | 'isEditable' | 'misspelledWord'>
  > = {},
) {
  return {
    dictionarySuggestions: [],
    editFlags,
    isEditable: true,
    misspelledWord: '',
    ...overrides,
  };
}

function invoke(item: MenuItemConstructorOptions): void {
  (item.click as () => void)();
}

describe('buildEditableContextMenuTemplate', () => {
  it('offers spelling replacements and a persistent dictionary action', () => {
    const replaceMisspelling = vi.fn();
    const addToDictionary = vi.fn();
    const template = buildEditableContextMenuTemplate(
      params({ misspelledWord: 'gezel', dictionarySuggestions: ['gazelle', 'guzzle'] }),
      { replaceMisspelling, addToDictionary },
    );

    expect(template.slice(0, 5).map(({ label, type }) => ({ label, type }))).toEqual([
      { label: 'gazelle', type: undefined },
      { label: 'guzzle', type: undefined },
      { label: undefined, type: 'separator' },
      { label: 'Add “gezel” to dictionary', type: undefined },
      { label: undefined, type: 'separator' },
    ]);

    invoke(template[0]!);
    invoke(template[3]!);
    expect(replaceMisspelling).toHaveBeenCalledWith('gazelle');
    expect(addToDictionary).toHaveBeenCalledWith('gezel');
  });

  it('keeps add-to-dictionary available when Chromium has no replacement', () => {
    const template = buildEditableContextMenuTemplate(params({ misspelledWord: 'gezel' }), {
      replaceMisspelling: vi.fn(),
      addToDictionary: vi.fn(),
    });

    expect(template[0]).toMatchObject({ label: 'No spelling suggestions', enabled: false });
    expect(template[2]).toMatchObject({ label: 'Add “gezel” to dictionary' });
  });

  it('provides normal editing actions outside a misspelling', () => {
    const template = buildEditableContextMenuTemplate(params(), {
      replaceMisspelling: vi.fn(),
      addToDictionary: vi.fn(),
    });

    expect(template.map(({ role, type, enabled }) => ({ role, type, enabled }))).toEqual([
      { role: 'undo', type: undefined, enabled: true },
      { role: 'redo', type: undefined, enabled: false },
      { role: undefined, type: 'separator', enabled: undefined },
      { role: 'cut', type: undefined, enabled: true },
      { role: 'copy', type: undefined, enabled: true },
      { role: 'paste', type: undefined, enabled: true },
      { role: 'delete', type: undefined, enabled: true },
      { role: undefined, type: 'separator', enabled: undefined },
      { role: 'selectAll', type: undefined, enabled: true },
    ]);
  });

  it('does not interfere with non-editable custom context menus', () => {
    expect(
      buildEditableContextMenuTemplate(params({ isEditable: false, misspelledWord: 'gezel' }), {
        replaceMisspelling: vi.fn(),
        addToDictionary: vi.fn(),
      }),
    ).toEqual([]);
  });
});
