import { embedProfileId } from '../memory/embed-core.js';
import { imageEmbedModelId } from '../memory/image-embed-core.js';
import { TEXT_EMBED_DIM } from './schema.js';
import type { SqliteDriver } from './sqlite-driver.js';

/**
 * Invalidate the text vectors when the embedding model changed. Vectors from a
 * different embedder are not comparable to the current model's query vectors
 * (garbage cosine similarity), so on a model swap we drop `vec_text` (recreated
 * at the current dim — handles a dim change too) and clear `enrichments` so the
 * enrichment loop re-embeds every file. Summaries + chunks survive, so
 * re-embedding pays no LLM cost (see enrichFile's summary reuse). First-ever
 * open just stamps the model; matching model is a no-op (no write on the hot
 * read-open path).
 */
export function reconcileEmbedModel(db: SqliteDriver, vecAvailable: boolean): void {
  // The stamp is the FULL profile identity (model|dim|pooling|norm|prefix
  // hashes), not the bare model id — so a dim or instruction change also
  // invalidates vectors. Pre-profile stamps mismatch once and re-embed.
  const current = embedProfileId();
  const stored = db
    .prepare("SELECT value FROM meta WHERE key = 'embed_model'")
    .get<{ value: string }>()?.value;
  if (stored === current) return;
  if (stored) {
    if (vecAvailable) {
      db.exec('DROP TABLE IF EXISTS vec_text');
      // Same metric + fallback discipline as applySchema — the re-embed
      // migration is also how pre-cosine tables pick up the declaration.
      try {
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text USING vec0(embedding float[${TEXT_EMBED_DIM}] distance_metric=cosine);`,
        );
      } catch {
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text USING vec0(embedding float[${TEXT_EMBED_DIM}]);`,
        );
      }
    }
    db.exec('DELETE FROM enrichments');
    // The embed-only gate holds the same invalidated vectors' bookkeeping.
    db.exec('DELETE FROM embed_state');
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embed_model', ?)").run(current);
}

/**
 * Same contract as {@link reconcileEmbedModel} for the media embedder: its
 * identity is the profile plus the vision token budget, since a budget change
 * moves every image vector. A change wipes media_vectors and the
 * image_embed_state gate (the tier re-embeds lazily). Face vectors are NOT
 * touched — the face embedder is a separate pinned model with its own catalog.
 */
export function reconcileImageEmbedModel(db: SqliteDriver): void {
  const current = imageEmbedModelId();
  const stored = db
    .prepare("SELECT value FROM meta WHERE key = 'image_embed_model'")
    .get<{ value: string }>()?.value;
  if (stored === current) return;
  if (stored) {
    db.exec('DELETE FROM media_vectors');
    db.exec('DELETE FROM image_embed_state');
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('image_embed_model', ?)").run(
    current,
  );
}
