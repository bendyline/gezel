export { loadRecording, type LoadedRecording } from './recording.js';
export {
  recordingToDoc,
  type RecordingDocResult,
  type RecordingToDocOptions,
} from './mapper/recordingToDoc.js';
export { RENDITION_KNOBS, type RenditionKnobs, type RenditionProfile } from './mapper/profiles.js';
export {
  narrationLine,
  coverTitle,
  coverSubtitle,
  marketingCaption,
  cleanExcerpt,
  toolVerb,
} from './mapper/narration.js';
export { runNeededHelp, isHarnessNudge } from './mapper/timing.js';
export type { EndCard } from './mapper/scenes.js';
export { MOVIE_PALETTE } from './mapper/scenes.js';
export {
  collectScreenshotRefs,
  hasPoppetjeMedia,
  poppetjeMediaPath,
  type MovieMediaRef,
} from './media.js';
