/**
 * Spelling + grammar proofing for gezel's squisq editors.
 *
 * The engine is harper.js — Apache-2.0, English only, WebAssembly,
 * running fully offline in a Web Worker. Squisq ships none of it: the
 * host installs the engine, serves its WASM same-origin, and passes a
 * provider into `EditorShell`. Gezel serves both binaries from
 * `/harper/` (staged by `scripts/vite-harper-wasm.ts`) so proofing works
 * on a laptop in a tunnel with no network, like everything else here.
 *
 * A module-scope SINGLETON instance rather than a factory: the editors
 * remount on every document switch, and harper's cold WASM setup is ~5s.
 * Handing squisq an instance keeps that warm engine alive across
 * remounts — the shell only disposes providers it created itself.
 * Construction is cheap and side-effect-free; nothing is fetched until a
 * markdown document is actually open with proofing on.
 *
 * Both host-owned stores below live in localStorage, matching the other
 * per-person editor preferences in this UI (export options, pane
 * widths). Neither belongs on disk under `~/.gezel/`: an accepted word
 * and a dismissed finding are one reader's preference on one machine,
 * not project state a gezel should ever read.
 */

import { createHarperProofingProvider } from '@bendyline/squisq-editor-react';
import type {
  ProofingDocumentRef,
  ProofingIgnoreStore,
  ProofingProvider,
} from '@bendyline/squisq-editor-react';

const DICTIONARY_STORAGE_KEY = 'gezel:proof-dictionary';
const IGNORE_STORAGE_KEY = 'gezel:proof-ignored';

/**
 * Cap on remembered per-document dismissal sets. localStorage is a
 * ~5 MB origin-wide budget shared with every other gezel preference, and
 * this record is the only one here that grows with use — an unbounded
 * one would eventually break unrelated features with a quota error.
 * Trimming is oldest-touched-first, so the documents someone is actually
 * working in keep their dismissals.
 */
const MAX_IGNORED_DOCUMENTS = 250;

function readDictionary(): string[] {
  try {
    const raw = window.localStorage.getItem(DICTIONARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

function appendDictionaryWord(word: string): void {
  try {
    const words = new Set(readDictionary());
    words.add(word);
    window.localStorage.setItem(DICTIONARY_STORAGE_KEY, JSON.stringify([...words]));
  } catch {
    // Storage denied or full — the word still applies to the running
    // engine, so the squiggle clears for this session either way.
  }
}

let provider: ProofingProvider | null = null;

/**
 * The shared proofing engine, built on first use and reused thereafter.
 *
 * Returns the same INSTANCE every time, and callers must pass that
 * instance — not this function — to `EditorShell`. Squisq treats a
 * function as a factory it owns and disposes on unmount, which would
 * throw away the warm engine on every document switch.
 *
 * Lazy rather than module-scope so that importing this barrel does not
 * reach into squisq at module-evaluation time: that made every test
 * mocking `@bendyline/squisq-editor-react` fail on an unrelated missing
 * export, and it did work at page load that belongs at first use.
 *
 * `onDictionaryWord` is what makes squisq offer "Add to dictionary" at
 * all — it reports `hasAppDictionary: onDictionaryWord != null` and
 * hides the item otherwise, so a word can never look saved app-wide and
 * then reappear on the next launch. Words added to a *document's* list
 * instead ride its `squisq-proof-dictionary` frontmatter and travel with
 * the file.
 */
export function gezelProofingProvider(): ProofingProvider {
  provider ??= createHarperProofingProvider({
    wasmUrl: '/harper/harper_wasm_bg.wasm',
    initialWords: readDictionary(),
    onDictionaryWord: appendDictionaryWord,
  });
  return provider;
}

function documentKey(doc: ProofingDocumentRef): string {
  return doc.fileName ?? doc.articleId;
}

function readIgnoreRecord(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(IGNORE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Findings the reader dismissed with "Ignore", kept per document.
 *
 * Dismissals are deliberately never written into the file — a document
 * travelling through git must not carry one person's "stop showing me
 * this" to everyone who opens it. So squisq hands the state to us
 * instead, as an opaque string: it encodes context hashes as integers
 * above 2^53, which means it is stored and returned verbatim and never
 * parsed.
 */
export const gezelProofingIgnoreStore: ProofingIgnoreStore = {
  load(doc) {
    return readIgnoreRecord()[documentKey(doc)];
  },
  save(doc, ignoredJson) {
    try {
      const record = readIgnoreRecord();
      const key = documentKey(doc);
      // Re-insert at the end so JSON key order tracks recency, which is
      // what the trim below reads as "oldest touched".
      delete record[key];
      record[key] = ignoredJson;
      const keys = Object.keys(record);
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_IGNORED_DOCUMENTS))) {
        delete record[stale];
      }
      window.localStorage.setItem(IGNORE_STORAGE_KEY, JSON.stringify(record));
    } catch {
      // Storage denied or full — the dismissal still holds for the rest
      // of the session.
    }
  },
};
