/**
 * Factual writing: which gezels write under the citation rule, which tools
 * count as evidence, which ones put text into a person's document, and the
 * standing prompt text.
 *
 * Factual mode follows the gezel's role, not the model: a writer, researcher
 * or reviewer states facts for a living, whatever runs them. A gezel can
 * override it either way (`factualWriting` in gezel.md), and any session
 * that can write into a person's document is factual regardless of role,
 * because that is where an invented date does the most harm and is the
 * least likely to be checked.
 */
import { resolveRoleId } from '../roles/registry.js';

/** Tools that put model text into a document the person is editing. */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'doc_insert_text',
  'doc_replace_selection',
  'slide_insert',
]);

/**
 * Tools that save a file. A prose file (`isProseFile`) is held to the same
 * rule as a document insert: a writer that answers "write a paragraph about
 * Martha's children" by saving one from memory is the case this exists for.
 */
export const PROSE_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'write_artifact',
  'write_document',
]);

const PROSE_FILE = /\.(?:md|markdown|mdx|txt|text|rst|adoc)$/i;

/** True for a path whose content is prose a person reads, not code or data. */
export function isProseFile(path: string | undefined): boolean {
  return typeof path === 'string' && PROSE_FILE.test(path.trim());
}

/**
 * Tools whose successful result is evidence the model may cite: retrieval,
 * reading, and the person's own open document.
 */
export const EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'search_documents',
  'search_docs',
  'search_memory',
  'read_document',
  'read_doc_as_markdown',
  'read_file',
  'read_artifact',
  'fetch_url',
  'web_search',
  'wikipedia_search',
  'wikipedia_read',
  'office_read_selection',
  'doc_read_selection',
  'doc_read',
  'doc_search',
  'slide_read',
  'sheet_read_selection',
  'sheet_read_range',
  'sheet_describe_table',
]);

/** Which source family should lead a factual lookup. */
export type FactualLookupPreference = 'default' | 'knowledge' | 'wikipedia';

/** Lookup tools the guidance names, ordered by the source actually in scope. */
const LOOKUP_TOOLS: Record<FactualLookupPreference, readonly string[]> = {
  default: [
    'search',
    'wikipedia_search',
    'wikipedia_read',
    'web_search',
    'fetch_url',
    'read_document',
  ],
  knowledge: ['search', 'wikipedia_search', 'wikipedia_read', 'web_search', 'fetch_url'],
  wikipedia: ['wikipedia_search', 'wikipedia_read', 'search', 'web_search', 'fetch_url'],
};

/** The lookup tools among `toolNames`, in the order a writer should try them. */
export function factualLookupTools(
  toolNames: Iterable<string>,
  preference: FactualLookupPreference = 'default',
): string[] {
  const available = new Set(toolNames);
  return LOOKUP_TOOLS[preference].filter((t) => available.has(t));
}

const FACTUAL_ROLE_IDS = new Set(['researcher', 'reviewer', 'copywriter']);
const FACTUAL_TITLE =
  /writ|author|edit|journal|report|histor|biograph|genealog|librar|archiv|boekwacht|fact|research|schrijv|verhal|omroep|redact|correspond|chronic/i;
/** Invention is the job: never hold these to the citation rule by title alone. */
const FICTION_TITLE =
  /fiction|novel|poet|screenwrit|songwrit|playwright|lyric|schrijfmaat|dichter/i;

/** True when a role's job is stating facts. */
export function isFactualRole(role: string | undefined): boolean {
  if (!role?.trim()) return false;
  if (FICTION_TITLE.test(role)) return false;
  const canonical = resolveRoleId(role);
  if (canonical && FACTUAL_ROLE_IDS.has(canonical)) return true;
  return FACTUAL_TITLE.test(role);
}

export interface FactualWritingInput {
  /** `factualWriting` from gezel.md: an explicit choice wins. */
  override?: boolean;
  role?: string;
  roleBasedName?: string;
  /** Names of the tools this session can call. */
  toolNames?: Iterable<string>;
}

export type FactualWritingReason = 'override' | 'role' | 'document' | 'off';

/** Whether this session writes under the citation rule, and why. */
export function resolveFactualWriting(input: FactualWritingInput): {
  on: boolean;
  reason: FactualWritingReason;
} {
  if (input.override !== undefined)
    return { on: input.override, reason: input.override ? 'override' : 'off' };
  if (isFactualRole(input.role) || isFactualRole(input.roleBasedName))
    return { on: true, reason: 'role' };
  for (const name of input.toolNames ?? []) {
    if (DOCUMENT_WRITE_TOOLS.has(name)) return { on: true, reason: 'document' };
  }
  return { on: false, reason: 'off' };
}

/**
 * The standing rule. `numbered` is true where the runtime numbers evidence
 * (every provider that runs tools through gezel's bridge); elsewhere the
 * model names its source instead.
 */
export function factualWritingGuidance(opts: {
  numbered: boolean;
  toolNames?: Iterable<string>;
  lookupPreference?: FactualLookupPreference;
}): string {
  const available = new Set(opts.toolNames ?? []);
  const preference = opts.lookupPreference ?? 'default';
  const lookups = factualLookupTools(available, preference);
  const writesDocuments = [...DOCUMENT_WRITE_TOOLS].some((t) => available.has(t));
  const savesFiles = [...PROSE_FILE_WRITE_TOOLS].some((t) => available.has(t));
  const lines = [
    '## Facts and sources',
    'You state facts, not guesses. Memory of names, dates, numbers, places, relationships and quotes is often wrong, even when it feels certain.',
    '- State a specific fact only when evidence in this conversation shows it: indexed context, a tool result, or what the person told you.',
  ];
  if (opts.numbered) {
    lines.push(
      '- Evidence arrives numbered: [1], [2], … Put the number at the end of each sentence that uses it: "They married on January 6, 1759 [3]." Cite only numbers you were given; never make one up.',
      '- The numbers exist only in this conversation. In a file you write, name the source itself (title and link or path), or follow the citation format your task gives.',
    );
  } else {
    lines.push('- After each fact, name where it came from: the document, page or result title.');
  }
  if (preference === 'wikipedia' && available.has('wikipedia_search')) {
    lines.push(
      '- No local knowledge catalog is in scope for this project. Start factual research with `wikipedia_search`; its results already include article lead text. Use `wikipedia_read` only when you need more of one exact article.',
    );
  } else if (preference === 'knowledge' && available.has('search')) {
    lines.push(
      '- A local knowledge catalog is in scope for this project. Start factual research with `search({ query, sources: ["knowledge"] })`, and preserve each returned `knowledge://` source URI in the file.',
    );
  }
  lines.push(
    lookups.length > 0
      ? `- Not in your evidence? Look it up first: ${lookups.map((t) => `\`${t}\``).join(', ')}.`
      : '- Not in your evidence? Ask the person for a source.',
    '- Still not found? Leave it out, or say plainly that you could not verify it. Never fill a gap from memory, and never smooth over a gap with a plausible detail.',
    '- Keep the source\'s certainty: if it says "about", "likely" or "disputed", so do you.',
  );
  if (writesDocuments && opts.numbered) {
    lines.push(
      '- Text you insert into the document follows the same rule, with [n] markers. gezel checks each fact against the evidence you cite and removes the markers before the text reaches the document.',
    );
  }
  if (savesFiles && opts.numbered) {
    lines.push(
      '- A prose file you save (.md, .txt) is checked too: research first, then write. A file stating facts no evidence shows is not saved.',
    );
  }
  return lines.join('\n');
}

/** The header line that numbers one piece of evidence for the model. */
export function evidenceLabel(n: number, tool: string, title?: string): string {
  return `[${n}] Evidence from \`${tool}\`${title ? ` — ${title}` : ''}. Cite facts from it as [${n}].`;
}
