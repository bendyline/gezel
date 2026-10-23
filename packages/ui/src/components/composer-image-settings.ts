/**
 * Pure rules behind the composer's image strip: what a direct image gezel's
 * next render will be, from its stored defaults, the person's picks, and the
 * settings the message itself names. The daemon merges in the same order
 * (`runFixedFunctionSend`), through the same core functions.
 */
import {
  IMAGE_ASPECT_RATIOS,
  type ImageAspectRatio,
  type ImageSettings,
  type ImageSizeSettings,
  type InstalledImageModel,
  imageSizeSettingsFrom,
  mergeImageSizeSettings,
  resolveImageSize,
} from '@bendyline/gezel';

/** The shapes on the strip's own keys; the rest sit behind "More". */
export const PRIMARY_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  '1:1',
  '4:5',
  '3:2',
  '16:9',
  '9:16',
];
export const MORE_ASPECT_RATIOS: readonly ImageAspectRatio[] = IMAGE_ASPECT_RATIOS.filter(
  (r) => !PRIMARY_ASPECT_RATIOS.includes(r),
);

export const ASPECT_RATIO_NAMES: Readonly<Record<ImageAspectRatio, string>> = {
  '1:1': 'Square',
  '4:5': 'Portrait post',
  '5:4': 'Wide post',
  '3:4': 'Portrait',
  '4:3': 'Landscape',
  '2:3': 'Tall photo',
  '3:2': 'Photo',
  '9:16': 'Phone, story',
  '16:9': 'Widescreen, slide',
  '21:9': 'Banner',
};

export function effectiveImageSettings(input: {
  defaults: Record<string, unknown> | undefined;
  picks: ImageSettings;
  cues: ImageSizeSettings | undefined;
}): ImageSizeSettings {
  return mergeImageSizeSettings(imageSizeSettingsFrom(input.defaults), input.picks, input.cues);
}

/** The pixels a local model renders these settings at; undefined for a cloud model. */
export function renderSizeFor(
  settings: ImageSizeSettings,
  model: InstalledImageModel | undefined,
): { width: number; height: number } | undefined {
  if (!model?.defaultSidePx) return undefined;
  return resolveImageSize(settings, {
    defaultSidePx: model.defaultSidePx,
    widthRange: model.widthRange,
    heightRange: model.heightRange,
  });
}

/** One line: "9:16 · 768×1344 · FLUX.2 Klein". */
export function imageSettingsReadout(
  settings: ImageSizeSettings,
  model: InstalledImageModel | undefined,
): string {
  const size = renderSizeFor(settings, model);
  const shape =
    settings.aspectRatio ??
    (settings.width && settings.height
      ? undefined
      : size && size.width === size.height
        ? '1:1'
        : undefined);
  const parts = [
    shape,
    size ? `${size.width}×${size.height}` : undefined,
    settings.quality && settings.quality !== 'standard' ? settings.quality : undefined,
    model?.name,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The send-body fields for the current picks and the text being sent. */
export function imageSendFields(input: {
  picks: ImageSettings;
  cuesDismissed: boolean;
}): { imageSettings?: ImageSettings; imageCues?: 'off' } {
  return {
    ...(Object.keys(input.picks).length > 0 ? { imageSettings: input.picks } : {}),
    ...(input.cuesDismissed ? { imageCues: 'off' as const } : {}),
  };
}
