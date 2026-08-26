import { api } from '../api.js';

/**
 * Hard cap on the characters fed to kokoro per turn. Long replies +
 * CPU contention from the LLM cascade (Meester → Voorman → Developer
 * handoffs each fire a fresh 16K-token prompt) starve the kokoro
 * inference on the main thread; a 30+ second synth just feels broken.
 * The full text is on screen anyway — narration is meant to be a
 * gist read, not the whole novel.
 */
const NARRATION_MAX_CHARS = 280;

/** Mutable cell for the in-flight synth's abort controller. */
type NarrationController = { current: AbortController | null };

/**
 * Stop the in-flight narration audio (if any) and clear the ref.
 * Safe to call when nothing is playing. Used both as a "new turn
 * starting, cut the old voice off" handler and at unmount.
 */
export function stopNarration(
  audioRef: { current: HTMLAudioElement | null },
  abortRef?: NarrationController,
): void {
  // Abort any synth still in flight. Without this, a slow synth from
  // a prior turn would resolve later and start playing over the next
  // gezel's audio.
  if (abortRef?.current) {
    abortRef.current.abort();
    abortRef.current = null;
  }
  const el = audioRef.current;
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* best-effort */
  }
  audioRef.current = null;
}

/**
 * Truncate text at the closest sentence-end boundary at or before
 * {@link NARRATION_MAX_CHARS}. Falls back to a hard char cut when no
 * sentence boundary lands in range so we don't speak a 4-token blurt.
 */
function truncateForNarration(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NARRATION_MAX_CHARS) return trimmed;
  const slice = trimmed.slice(0, NARRATION_MAX_CHARS);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (sentenceEnd >= NARRATION_MAX_CHARS / 2) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }
  return `${slice.trim()}…`;
}

/**
 * Fetch a TTS rendering of `text` for the speaking gezel and start
 * playback. Stops any prior narration so we never stack overlapping
 * voices. The route resolves the voice from the gezel's frontmatter
 * when we pass `gezelId` — no need to look it up here.
 */
export async function playAssistantNarration(
  text: string,
  gezelId: string,
  projectId: string,
  audioRef: { current: HTMLAudioElement | null },
  abortRef: NarrationController,
): Promise<void> {
  // Cut any prior playback AND abort any prior synth before kicking
  // off the new one. Prevents stacked audio and pile-up under load.
  stopNarration(audioRef, abortRef);
  const ctrl = new AbortController();
  abortRef.current = ctrl;

  const synthText = truncateForNarration(text);
  console.debug(
    `[narrate] synth start chars=${synthText.length} (of ${text.length}) gezelId=${gezelId}`,
  );
  let res: Awaited<ReturnType<typeof api.synthesizeSpeech>>;
  try {
    res = await api.synthesizeSpeech({
      text: synthText,
      gezelId,
      projectId,
      inline: true,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) {
      console.debug('[narrate] synth aborted (superseded by newer turn)');
      return;
    }
    console.warn('[narrate] synth failed:', err);
    return;
  }
  // If a newer turn aborted us between synth-resolve and play, drop it.
  if (ctrl.signal.aborted) {
    console.debug('[narrate] synth resolved but aborted — dropping');
    return;
  }
  console.debug(`[narrate] synth ok b64Len=${res.b64Wav?.length ?? 0} meta=`, res.meta);
  if (!res.b64Wav) {
    console.warn('[narrate] synth returned no b64Wav — narration skipped');
    return;
  }
  const audio = new Audio(`data:audio/wav;base64,${res.b64Wav}`);
  audioRef.current = audio;
  audio.addEventListener('ended', () => {
    console.debug('[narrate] playback ended');
    if (audioRef.current === audio) audioRef.current = null;
    if (abortRef.current === ctrl) abortRef.current = null;
  });
  try {
    await audio.play();
    console.debug('[narrate] playback started');
  } catch (err) {
    console.warn('[narrate] playback rejected:', err);
    if (audioRef.current === audio) audioRef.current = null;
    if (abortRef.current === ctrl) abortRef.current = null;
  }
}
