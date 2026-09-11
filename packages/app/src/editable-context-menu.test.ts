import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  type EditableContextMenuActions,
  buildEditableContextMenuTemplate,
} from './editable-context-menu.js';

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
    Pick<
      ContextMenuParams,
      | 'dictionarySuggestions'
      | 'editFlags'
      | 'hasImageContents'
      | 'isEditable'
      | 'mediaType'
      | 'misspelledWord'
      | 'x'
      | 'y'
    >
  > = {},
) {
  return {
    dictionarySuggestions: [],
    editFlags,
    hasImageContents: false,
    isEditable: true,
    mediaType: 'none' as const,
    misspelledWord: '',
    x: 0,
    y: 0,
    ...overrides,
  };
}

function actions(overrides: Partial<EditableContextMenuActions> = {}): EditableContextMenuActions {
  return {
    addToDictionary: vi.fn(),
    copyImageAt: vi.fn(),
    replaceMisspelling: vi.fn(),
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
      actions({ replaceMisspelling, addToDictionary }),
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
    const template = buildEditableContextMenuTemplate(
      params({ misspelledWord: 'gezel' }),
      actions(),
    );

    expect(template[0]).toMatchObject({ label: 'No spelling suggestions', enabled: false });
    expect(template[2]).toMatchObject({ label: 'Add “gezel” to dictionary' });
  });

  it('provides normal editing actions outside a misspelling', () => {
    const template = buildEditableContextMenuTemplate(params(), actions());

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
      buildEditableContextMenuTemplate(
        params({ isEditable: false, misspelledWord: 'gezel' }),
        actions(),
      ),
    ).toEqual([]);
  });

  it('copies the decoded bitmap when an image is right-clicked', () => {
    const copyImageAt = vi.fn();
    const template = buildEditableContextMenuTemplate(
      params({
        hasImageContents: true,
        isEditable: false,
        mediaType: 'image',
        x: 48,
        y: 72,
      }),
      actions({ copyImageAt }),
    );

    expect(template).toHaveLength(1);
    expect(template[0]).toMatchObject({ label: 'Copy Image' });
    invoke(template[0]!);
    expect(copyImageAt).toHaveBeenCalledWith(48, 72);
  });

  it('keeps image copying alongside edit actions for inline editor images', () => {
    const template = buildEditableContextMenuTemplate(
      params({ hasImageContents: true, mediaType: 'image' }),
      actions(),
    );

    expect(template[0]).toMatchObject({ label: 'Copy Image' });
    expect(template[1]).toMatchObject({ type: 'separator' });
    expect(template.some(({ role }) => role === 'copy')).toBe(true);
  });
});
