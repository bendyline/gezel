import {
  type CatalogItemDetail,
  type CatalogItemSummary,
  type CatalogItemVersionInfo,
  type CatalogKind,
  type ChatModelManifest,
  applyTuningDonor,
  isImportedChatModel,
} from '@bendyline/gezel';

/** One imported model as stored: its manifest and the curated entry it borrows settings from. */
export interface ImportedChatModelRecord {
  manifest: ChatModelManifest;
  tuningFrom?: string;
}

/**
 * Reads the chat models a person added from outside the catalog. The service
 * supplies it (the entries live beside each model's weights, a layout only
 * the inference package knows); this package only serves what it returns.
 */
export interface ImportedChatModelReader {
  get(id: string): Promise<ImportedChatModelRecord | null>;
  list(): Promise<ImportedChatModelRecord[]>;
}

/** Looks a curated entry up in the rest of the catalog, for borrowed settings. */
export type CuratedChatModelLookup = (id: string) => Promise<ChatModelManifest | null>;

/**
 * Chat models added from Hugging Face or from a file, served last so a curated
 * entry always wins an id collision (imported ids carry an `hf-` or `local-`
 * prefix, so none should occur). Only `chat-model`, and only what the reader
 * returns: it validates and strips each entry before it reaches here.
 *
 * An entry that names a donor (`tuningFrom`) is served with that curated
 * entry's style, behaviors and tuning, read live, so a catalog update that
 * retunes the donor retunes the imported model too.
 */
export class ImportedChatModelsSource {
  readonly id = 'imported';
  readonly label = 'Added from outside the catalog';
  private readonly reader: ImportedChatModelReader;
  private readonly lookupCurated: CuratedChatModelLookup | undefined;

  constructor(reader: ImportedChatModelReader, lookupCurated?: CuratedChatModelLookup) {
    this.reader = reader;
    this.lookupCurated = lookupCurated;
  }

  private async resolve(record: ImportedChatModelRecord): Promise<ChatModelManifest> {
    if (!record.tuningFrom || !this.lookupCurated) return record.manifest;
    const donor = await this.lookupCurated(record.tuningFrom).catch(() => null);
    if (!donor || donor.kind !== 'chat-model' || isImportedChatModel(donor)) return record.manifest;
    return applyTuningDonor(record.manifest, donor);
  }

  async listKinds(): Promise<CatalogKind[]> {
    return ['chat-model'];
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (kind !== 'chat-model') return [];
    const records = await this.reader.list().catch(() => []);
    const manifests = await Promise.all(records.map((record) => this.resolve(record)));
    return manifests.map((manifest) => ({ sourceId: this.id, kind, manifest }));
  }

  async get(kind: CatalogKind, id: string, version?: string): Promise<CatalogItemDetail | null> {
    if (kind !== 'chat-model') return null;
    const record = await this.reader.get(id).catch(() => null);
    if (!record) return null;
    if (version !== undefined && version !== record.manifest.version) return null;
    return { sourceId: this.id, kind, manifest: await this.resolve(record) };
  }

  async listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]> {
    const detail = await this.get(kind, id);
    if (!detail || detail.manifest.kind !== 'chat-model') return [];
    return [
      { version: detail.manifest.version, releasedAt: detail.manifest.releasedAt, yanked: false },
    ];
  }

  async readItemFile(): Promise<Buffer | null> {
    return null;
  }
}
