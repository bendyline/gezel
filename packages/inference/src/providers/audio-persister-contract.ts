export interface ToolAudioPersister {
  persist(
    audios: ReadonlyArray<{
      base64: string;
      mimeType: string;
      durationSeconds?: number;
      voice?: string;
    }>,
  ): Promise<Array<{ path: string; mimeType: string; durationSeconds?: number; voice?: string }>>;
}
