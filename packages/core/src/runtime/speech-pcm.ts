/** Normalize the shared composer's WAV takes for both native STT backends.
 * File input is deliberately bounded; unsupported codecs fail before a system
 * API could accidentally treat a failed file descriptor as microphone input. */
export function speechPcm16(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (
    wav.length < 44 ||
    tag(0) !== 'RIFF' ||
    tag(8) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== wav.length
  )
    throw new Error('Choose an uncompressed PCM WAV recording.');
  let rate = 0;
  let channels = 0;
  let data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= wav.length; ) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > wav.length) throw new Error('The WAV recording is incomplete.');
    if (tag(at) === 'fmt ') {
      if (size < 16 || view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16)
        throw new Error('Use a 16-bit PCM WAV recording.');
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      if (
        channels < 1 ||
        channels > 2 ||
        rate < 8000 ||
        rate > 96000 ||
        view.getUint16(at + 20, true) !== channels * 2 ||
        view.getUint32(at + 16, true) !== rate * channels * 2
      )
        throw new Error('Unsupported WAV recording format.');
    }
    if (tag(at) === 'data') {
      if (data) throw new Error('Use one audio stream per recording.');
      data = wav.subarray(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
  if (!rate || !data?.length || data.length % (channels * 2) !== 0)
    throw new Error('The recording contains no complete audio samples.');
  const frames = data.length / (channels * 2);
  if (frames > rate * 120)
    throw new Error('Transcribe up to two minutes at a time on this device.');
  const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mono = (frame: number) => {
    let total = 0;
    for (let channel = 0; channel < channels; channel++)
      total += samples.getInt16((Math.min(frames - 1, frame) * channels + channel) * 2, true);
    return total / channels;
  };
  const length = Math.max(1, Math.floor((frames * 16000) / rate));
  const output = new Uint8Array(length * 2);
  const encoded = new DataView(output.buffer);
  for (let i = 0; i < length; ++i) {
    const start = (i * rate) / 16000;
    const end = Math.min(frames, ((i + 1) * rate) / 16000);
    let value = 0;
    for (let frame = Math.floor(start); frame < Math.ceil(end); frame++)
      value += mono(frame) * (Math.min(end, frame + 1) - Math.max(start, frame));
    encoded.setInt16(i * 2, Math.round(value / (end - start)), true);
  }
  return output;
}
