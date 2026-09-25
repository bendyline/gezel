/**
 * Make a mock's declared responses agree with what the mock actually did.
 *
 * A `test.json` declares canned tool responses — `save_artifact` answers
 * `bytes: 2400, sha256: "2222…"`, `preview_document` answers `slides: 7` —
 * written before anyone knew what the trial would produce. Once the saved
 * deck is built from the approved source, those numbers become claims a
 * reviewer can check and find false: powerpoint-deck's `evaluate` step
 * verifies "native slide count = H1 count" from the preview, so a 6- or
 * 8-slide deck previewed as 7 fails exactly like the placeholder deck did.
 *
 * Reconciliation patches the SPECIFIC fields named in {@link MOCK_RESPONSE_FIELDS}
 * — never a blind search-and-replace of numbers — and only when the declared
 * field already exists with the same type, so every response keeps the shape
 * its template declared. When the truth is unknown (no readable source, a
 * document this trial did not produce), the declared value stands.
 */

import { createHash } from 'node:crypto';
import {
  type MockConversionRecord,
  type MockSourceContext,
  asRecord,
  conversionForUri,
  readProjectFile,
} from './conversion-source.ts';
import { buildDocumentFromMarkdown, isSourceFaithfulFormat } from './markdown-office.ts';

export interface MockMaterialization {
  sha256: string;
  bytes: number;
  /** Slides in the written deck when it was built from a source; null for fixed fixtures and non-decks. */
  slideCount: number | null;
}

/** What one mock service has produced this trial; outlives the per-request MCP server. */
export interface MockDocumentLedger {
  /** Conversions served, oldest first. */
  conversions: MockConversionRecord[];
  /**
   * Every file a file effect wrote, by sha256 — so a copy of it anywhere
   * (`copy_artifact_to_workspace` preserves bytes) is recognized by content.
   */
  materializations: Map<string, MockMaterialization>;
}

export function createMockDocumentLedger(): MockDocumentLedger {
  return { conversions: [], materializations: new Map() };
}

/** Field path → the declared value and the value it was replaced with. */
export type ReconciledFields = Record<string, { declared: unknown; actual: unknown }>;

interface FileFields {
  bytes: readonly string[];
  sha256: readonly string[];
}

interface ResponseFieldMap {
  /** Top-level fields reporting the file this call just materialized. */
  savedFile?: FileFields;
  /** Top-level fields reporting a deck's slide count. */
  slideCount?: readonly string[];
  /** Fields of each top-level `artifacts[]` entry, rebuilt for that entry's `format`. */
  artifacts?: FileFields;
}

/**
 * The declared response fields that report facts about documents this trial
 * produced, keyed by tool name. Page-count fields are listed only for tools
 * whose count is a DECK's: a slide count is computed only for PPTX output, so
 * a DOCX preview's `pages` has no known truth and keeps its declared value.
 */
export const MOCK_RESPONSE_FIELDS: Readonly<Record<string, ResponseFieldMap>> = {
  save_artifact: { savedFile: { bytes: ['bytes'], sha256: ['sha256'] } },
  convert_document: {
    slideCount: ['slides', 'slideCount'],
    artifacts: { bytes: ['bytes'], sha256: ['sha256'] },
  },
  preview_document: { slideCount: ['slides', 'slideCount', 'pages', 'pageCount'] },
  inspect_document: { slideCount: ['slides', 'slideCount', 'pages', 'pageCount'] },
};

const MAX_DECK_BYTES = 32 * 1024 * 1024;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Return the served response with every mapped field that disagrees with
 * what this trial actually produced replaced by the truth. The declared
 * template is never mutated — it is shared by every call.
 */
export async function reconcileMockResponse(
  toolName: string,
  served: unknown,
  facts: {
    args: unknown;
    /** Set when this call IS a conversion: its own record. */
    conversion: MockConversionRecord | null;
    /** Set when this call wrote a file. */
    materialized: MockMaterialization | null;
    ledger: MockDocumentLedger;
    context: MockSourceContext;
  },
): Promise<{ response: unknown; reconciled: ReconciledFields | null }> {
  const fields = MOCK_RESPONSE_FIELDS[toolName];
  const declared = asRecord(served);
  if (!fields || !declared) return { response: served, reconciled: null };

  const response = structuredClone(declared);
  const reconciled: ReconciledFields = {};
  const patch = (
    target: Record<string, unknown>,
    keys: readonly string[],
    actual: number | string | null,
    prefix = '',
  ) => {
    if (actual === null) return;
    for (const key of keys) {
      const current = target[key];
      if (typeof current !== typeof actual || current === actual) continue;
      target[key] = actual;
      reconciled[`${prefix}${key}`] = { declared: current, actual };
    }
  };

  if (fields.savedFile && facts.materialized) {
    patch(response, fields.savedFile.bytes, facts.materialized.bytes);
    patch(response, fields.savedFile.sha256, facts.materialized.sha256);
  }
  if (fields.slideCount) {
    const count = facts.conversion
      ? facts.conversion.slideCount
      : await deckSlideCount(facts.args, facts.ledger, facts.context);
    patch(response, fields.slideCount, count);
  }
  const source = facts.conversion?.source;
  if (fields.artifacts && source && Array.isArray(response.artifacts)) {
    const artifactFields = fields.artifacts;
    response.artifacts.forEach((entry, index) => {
      const artifact = asRecord(entry);
      const format = typeof artifact?.format === 'string' ? artifact.format.toLowerCase() : null;
      if (!artifact || !isSourceFaithfulFormat(format)) return;
      // The same builder and source the later save materializes from, so the
      // converted artifact's hash is the saved file's hash.
      const bytes = buildDocumentFromMarkdown(format, source.markdown, {
        slideBreak: source.slideBreak,
      });
      if (!bytes) return;
      patch(artifact, artifactFields.bytes, bytes.length, `artifacts[${index}].`);
      patch(artifact, artifactFields.sha256, sha256Hex(bytes), `artifacts[${index}].`);
    });
  }
  return { response, reconciled: Object.keys(reconciled).length > 0 ? reconciled : null };
}

/**
 * The slide count of the deck a preview/inspect call names: a conversion's
 * output by the URI it returned, or a saved file recognized by its bytes.
 * Null for anything this trial did not produce from a known source.
 */
async function deckSlideCount(
  args: unknown,
  ledger: MockDocumentLedger,
  context: MockSourceContext,
): Promise<number | null> {
  const source = asRecord(args)?.source;
  const structured = asRecord(source);
  if (structured?.kind === 'artifact' && typeof structured.uri === 'string') {
    return conversionForUri(structured.uri, ledger.conversions)?.slideCount ?? null;
  }
  const path =
    typeof source === 'string'
      ? source
      : structured?.kind === 'file' && typeof structured.path === 'string'
        ? structured.path
        : null;
  if (!path) return null;
  const file = await readProjectFile(context, path, structured?.rootId, {
    pattern: /\.pptx$/i,
    maxBytes: MAX_DECK_BYTES,
  });
  if (!file) return null;
  return ledger.materializations.get(sha256Hex(file.bytes))?.slideCount ?? null;
}
