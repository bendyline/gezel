/**
 * Normalize MediaRecorder output for whisper.cpp.
 *
 * Chromium records microphone audio as WebM/Opus. The bundled whisper-server
 * only decodes PCM WAV unless it can shell out to ffmpeg, which a packaged
 * desktop install cannot assume is present. Chromium can decode its own
 * recording formats, so turn each self-contained take into mono 16-bit WAV
 * before it crosses the service boundary.
 */

export async function microphoneTakeAsWav(blob: Blob): Promise<Blob> {
  if (/^audio\/(?:wav|wave|x-wav)(?:;|$)/i.test(blob.type)) return blob;
  if (typeof AudioContext === 'undefined') {
    throw new Error('This recording could not be prepared for speech-to-text.');
  }

  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
      audio.getChannelData(index),
    );
    const bytes = encodeMonoPcm16Wav(channels, audio.sampleRate);
    return new Blob([bytes.buffer], { type: 'audio/wav' });
  } catch (caught) {
    const detail = caught instanceof Error && caught.message ? ` (${caught.message})` : '';
    throw new Error(`This recording could not be prepared for speech-to-text${detail}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function encodeMonoPcm16Wav(
  channels: readonly Float32Array[],
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const sampleCount = channels[0]?.length ?? 0;
  if (channels.length === 0 || sampleCount === 0) {
    throw new Error('The microphone recording was empty.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('The microphone recording has an invalid sample rate.');
  }
  if (channels.some((channel) => channel.length !== sampleCount)) {
    throw new Error('The microphone recording channels have different lengths.');
  }

  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < sampleCount; index += 1) {
    let mono = 0;
    for (const channel of channels) mono += channel[index] ?? 0;
    mono = Math.max(-1, Math.min(1, mono / channels.length));
    const pcm = mono < 0 ? Math.round(mono * 0x8000) : Math.round(mono * 0x7fff);
    view.setInt16(44 + index * bytesPerSample, pcm, true);
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
