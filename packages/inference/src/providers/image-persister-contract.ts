export interface ToolImagePersister {
  /**
   * Write all images from a single tool result to the project artifacts
   * tree. The persister owns an internal monotonic counter so multiple
   * calls of the same tool inside one session don't collide on filename.
   * Returns the saved relative paths, parallel to the input array.
   */
  persist(
    images: ReadonlyArray<{ base64: string; mimeType: string }>,
  ): Promise<Array<{ path: string; mimeType: string }>>;
}
