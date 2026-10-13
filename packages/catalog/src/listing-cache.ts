/** One snapshot per catalog kind, with concurrent readers sharing resolution. */
export class ListingCache<T> {
  private readonly entries = new Map<
    string,
    { path: string; text: string; value: Promise<{ items: T; cacheable: boolean }> }
  >();

  async read(
    kind: string,
    path: string,
    text: string,
    resolve: () => Promise<{ items: T; cacheable: boolean }>,
  ): Promise<T> {
    let entry = this.entries.get(kind);
    if (!entry || entry.path !== path || entry.text !== text) {
      entry = { path, text, value: resolve() };
      this.entries.set(kind, entry);
    }
    try {
      const result = await entry.value;
      // An older eligible version can come from a loose file outside the
      // index. Its edits must remain visible even when the index is unchanged.
      if (!result.cacheable && this.entries.get(kind) === entry) this.entries.delete(kind);
      // Callers have always owned their results; sorting or editing one must
      // not change the next request's catalog.
      return structuredClone(result.items);
    } catch (error) {
      if (this.entries.get(kind) === entry) this.entries.delete(kind);
      throw error;
    }
  }
}
