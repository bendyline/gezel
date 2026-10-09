import {
  CHARACTER_QUIRKS,
  CHARACTER_STYLES,
  CHARACTER_TEMPERAMENTS,
  type GezelCharacter,
  type GezelDetail,
  QUIRK_EFFECTS,
  STYLE_EFFECTS,
  TEMPERAMENT_EFFECTS,
  seedCharacter,
  sociabilityEffect,
} from '@bendyline/gezel';
import { useState } from 'react';
import { api } from '../api.js';

const SOCIABILITY_LABELS = ['Quiet', 'Brief', 'Easy', 'Chatty', 'Talkative'] as const;

const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * A gezel's character, edited in place: temperament, quirk, style and
 * sociability, each a row of keys. Below them, the exact lines the model
 * reads in social mode, so nothing about a choice is hidden.
 */
export function CharacterEditor({
  gezel,
  onUpdated,
}: {
  gezel: GezelDetail;
  onUpdated: (detail: GezelDetail) => void;
}) {
  const character = gezel.character ?? seedCharacter(gezel.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async (patch: Partial<GezelCharacter>) => {
    setSaving(true);
    setError('');
    try {
      onUpdated(await api.updateGezelSettings(gezel.id, { character: { ...character, ...patch } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const row = <T extends string | number>(
    name: string,
    values: readonly T[],
    current: T,
    text: (value: T) => string,
    hint: (value: T) => string,
    pick: (value: T) => Partial<GezelCharacter>,
  ) => (
    <div className="character-editor-row">
      <span className="character-editor-label">{name}</span>
      <div className="gz-tray" role="radiogroup" aria-label={name}>
        {values.map((value) => (
          <button
            key={String(value)}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
            role="radio"
            aria-checked={value === current}
            title={hint(value)}
            disabled={saving}
            className={`gz-key${value === current ? ' gz-key-active' : ''}`}
            onClick={() => void save(pick(value))}
          >
            {text(value)}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <section className="character-editor" aria-label="Character">
      <strong>Character</strong>
      <span className="muted small">
        How {gezel.name} comes across in chat when social mode is on.
      </span>
      {row(
        'Temperament',
        CHARACTER_TEMPERAMENTS,
        character.temperament,
        label,
        (value) => TEMPERAMENT_EFFECTS[value].line,
        (temperament) => ({ temperament }),
      )}
      {row(
        'Quirk',
        CHARACTER_QUIRKS,
        character.quirk,
        label,
        (value) => QUIRK_EFFECTS[value].line,
        (quirk) => ({ quirk }),
      )}
      {row(
        'Style',
        CHARACTER_STYLES,
        character.style,
        label,
        (value) => STYLE_EFFECTS[value].line,
        (style) => ({ style }),
      )}
      {row(
        'Sociability',
        [0, 1, 2, 3, 4] as const,
        character.sociability as 0 | 1 | 2 | 3 | 4,
        (value) => SOCIABILITY_LABELS[value],
        (value) => sociabilityEffect(value).line,
        (sociability) => ({ sociability }),
      )}
      <ul className="character-editor-effects muted small">
        <li>
          {STYLE_EFFECTS[character.style].line} {TEMPERAMENT_EFFECTS[character.temperament].line}
        </li>
        <li>{QUIRK_EFFECTS[character.quirk].line}</li>
        <li>{sociabilityEffect(character.sociability).line}</li>
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
