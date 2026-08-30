/** Convert the built-in TTS provider's WAV output into a real MP3 on demand. */
export async function encodeWavAsMp3(wav: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await wav.arrayBuffer());
    const channelData = Array.from({ length: Math.min(audio.numberOfChannels, 2) }, (_, index) =>
      audio.getChannelData(index),
    );
    const { default: createMp3Encoder } = await import('@audio/encode-mp3');
    const encoder = await createMp3Encoder({
      sampleRate: audio.sampleRate,
      channels: channelData.length,
      bitrate: 128,
    });
    const parts: Uint8Array[] = [];
    const chunkSamples = 1152 * 100;
    try {
      for (let offset = 0; offset < audio.length; offset += chunkSamples) {
        const end = Math.min(audio.length, offset + chunkSamples);
        const part = encoder.encode(channelData.map((channel) => channel.subarray(offset, end)));
        if (part.length > 0) parts.push(part);
        // Keep long-document conversion from monopolizing the renderer.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      const tail = encoder.flush();
      if (tail.length > 0) parts.push(tail);
    } finally {
      encoder.free();
    }
    const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
    const joined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return new Blob([joined.buffer], { type: 'audio/mpeg' });
  } finally {
    await context.close().catch(() => undefined);
  }
}
