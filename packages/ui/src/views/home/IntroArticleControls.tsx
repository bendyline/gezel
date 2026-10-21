import { onRadioKeyDown } from '../../primitives/radio-keyboard.js';
export function IntroArticleControls({
  mode,
  onModeChange,
  onOpen,
  compact = false,
}: {
  mode: 'doc' | 'video';
  onModeChange?: (mode: 'doc' | 'video') => void;
  onOpen?: () => void;
  compact?: boolean;
}) {
  return (
    <div className="home-intro-article-controls">
      {compact ? (
        <button
          type="button"
          className="gz-link-button"
          onClick={() => onOpen?.()}
          title="Read this article in the Handboek"
          disabled={!onOpen}
        >
          Open in Handboek →
        </button>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: a tray of keys, not a form; <fieldset> would bring a legend and form-group styling.
        <div className="gz-tray handboek-mode-tray" role="group" aria-label="Handboek article">
          <div
            className="home-intro-modes"
            role="radiogroup"
            aria-label="View as"
            onKeyDown={onRadioKeyDown}
          >
            <button
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
              role="radio"
              aria-checked={mode === 'doc'}
              tabIndex={mode === 'doc' ? 0 : -1}
              className={mode === 'doc' ? 'gz-key gz-key-active' : 'gz-key'}
              onClick={() => onModeChange?.('doc')}
            >
              Read
            </button>
            <button
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
              role="radio"
              aria-checked={mode === 'video'}
              tabIndex={mode === 'video' ? 0 : -1}
              className={mode === 'video' ? 'gz-key gz-key-active' : 'gz-key'}
              onClick={() => onModeChange?.('video')}
              disabled={!onModeChange}
            >
              Watch
            </button>
          </div>
          <span className="home-intro-tray-divider" aria-hidden="true" />
          <button
            type="button"
            className="gz-key"
            onClick={() => onOpen?.()}
            title="Read this article in the Handboek"
            disabled={!onOpen}
          >
            Open in Handboek <span aria-hidden="true">→</span>
          </button>
        </div>
      )}
    </div>
  );
}
