import { type ImageAspectRatio, type ImageQuality, aspectRatioValue } from '@bendyline/gezel';
import * as Select from '../primitives/Select.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import {
  ASPECT_RATIO_NAMES,
  MORE_ASPECT_RATIOS,
  PRIMARY_ASPECT_RATIOS,
  imageSettingsReadout,
} from './composer-image-settings.js';
import type { ComposerImageSettings } from './useComposerImageSettings.js';

const QUALITY_KEYS: ReadonlyArray<{ id: ImageQuality; label: string; hint: string }> = [
  { id: 'draft', label: 'Draft', hint: 'A quarter of the size: a fast first look' },
  { id: 'standard', label: 'Standard', hint: 'The size the model was trained at' },
  { id: 'high', label: 'High', hint: 'Larger and slower, held to what the model supports' },
];

/** A small rectangle in the ratio's own proportions. */
function AspectGlyph({ ratio }: { ratio: ImageAspectRatio }) {
  const value = aspectRatioValue(ratio);
  const w = value >= 1 ? 14 : 14 * value;
  const h = value >= 1 ? 14 / value : 14;
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect
        x={(16 - w) / 2}
        y={(16 - h) / 2}
        width={w}
        height={h}
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/**
 * The strip above a direct image gezel's composer: the shape, size tier and
 * model the next render uses, with a one-line readout of the pixels. It is
 * dashed while the shape comes from the message ("9:16", "a phone
 * wallpaper"), like a suggested task, with a key to send the words as typed.
 * See docs/ux.md.
 */
export function ComposerImageSettingsBar({ settings }: { settings: ComposerImageSettings }) {
  const { effective, model, models, cues, picks } = settings;
  const fromText = cues !== null;
  const aspect = effective.aspectRatio;
  const quality = effective.quality ?? 'standard';
  const moreValue = aspect && MORE_ASPECT_RATIOS.includes(aspect) ? aspect : undefined;
  const readout = imageSettingsReadout(effective, model);
  // Exact pixels (a default, or "1920x1080" in the message) latch no shape.
  const latched = PRIMARY_ASPECT_RATIOS.find(
    (ratio) => ratio === (aspect ?? (effective.width ? undefined : '1:1')),
  );

  return (
    <fieldset
      className="chat-composer-image-bar"
      data-origin={fromText ? 'suggested' : 'user'}
      aria-label="Image settings"
    >
      <div className="chat-composer-image-bar-row">
        <span className="chat-composer-task-bar-eyebrow">
          {fromText ? 'From your message' : 'Image'}
        </span>
        <div
          className="gz-tray chat-composer-image-bar-tray"
          role="radiogroup"
          aria-label="Shape"
          onKeyDown={onRadioKeyDown}
        >
          {PRIMARY_ASPECT_RATIOS.map((ratio) => {
            const selected = ratio === latched;
            return (
              <button
                key={ratio}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                role="radio"
                aria-checked={selected}
                tabIndex={ratio === (latched ?? '1:1') ? 0 : -1}
                className={`gz-key chat-composer-image-bar-key${selected ? ' gz-key-active' : ''}`}
                title={`${ratio} · ${ASPECT_RATIO_NAMES[ratio]}`}
                aria-label={`${ratio}, ${ASPECT_RATIO_NAMES[ratio]}`}
                onClick={() => settings.pick({ aspectRatio: ratio })}
              >
                <AspectGlyph ratio={ratio} />
                <span>{ratio}</span>
              </button>
            );
          })}
        </div>
        <Select.Root
          value={moreValue ?? ''}
          onValueChange={(next) => settings.pick({ aspectRatio: next as ImageAspectRatio })}
        >
          <Select.Trigger
            className="chat-composer-image-bar-more"
            aria-label="More shapes"
            title="More shapes"
          >
            {moreValue ?? 'More'}
          </Select.Trigger>
          <Select.Content align="start">
            {MORE_ASPECT_RATIOS.map((ratio) => (
              <Select.Item key={ratio} value={ratio} textValue={ratio}>
                {ratio} · {ASPECT_RATIO_NAMES[ratio]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <div
          className="gz-tray chat-composer-image-bar-tray"
          role="radiogroup"
          aria-label="Size"
          onKeyDown={onRadioKeyDown}
        >
          {QUALITY_KEYS.map((key) => {
            const selected = key.id === quality;
            const refused = key.id === 'high' ? settings.highRefusal : null;
            return (
              <button
                key={key.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                disabled={refused !== null && !selected}
                className={`gz-key chat-composer-image-bar-key${selected ? ' gz-key-active' : ''}`}
                title={refused ?? key.hint}
                onClick={() => settings.pick({ quality: key.id })}
              >
                {key.label}
              </button>
            );
          })}
        </div>
        {models.length > 1 && (
          <Select.Root
            value={model?.id ?? ''}
            onValueChange={(next) => settings.pick({ model: next })}
          >
            <Select.Trigger className="chat-composer-image-bar-model" aria-label="Image model">
              {model?.name ?? 'Model'}
            </Select.Trigger>
            <Select.Content align="start">
              {models.map((m) => (
                <Select.Item key={m.id} value={m.id} textValue={m.name}>
                  {m.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        )}
        {fromText && (
          <button
            type="button"
            className="gz-key chat-composer-image-bar-astyped"
            onClick={settings.dismissCues}
            title={`Send "${cues.cues.map((c) => c.text).join(', ')}" as part of the prompt instead`}
          >
            Use as typed
          </button>
        )}
      </div>
      {readout && (
        <span className="chat-composer-task-bar-params chat-composer-image-bar-readout">
          {readout}
          {Object.keys(picks).length === 0 && !fromText ? ' · default' : ''}
        </span>
      )}
    </fieldset>
  );
}
