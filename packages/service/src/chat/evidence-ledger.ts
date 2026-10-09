/**
 * A factual-mode session's numbered evidence.
 *
 * Everything the model reads that can back a fact — indexed context
 * injected with a turn, and the result of every evidence tool — gets a
 * session-wide number the model cites as `[n]`. Numbers never restart, so
 * a `[3]` in turn five still means what it meant in turn two.
 *
 * The ledger then holds the model to it twice. Text bound for a person's
 * document, or saved as a prose file, is checked before it lands: a
 * sentence stating a name, date, number or quote that no evidence shows is
 * refused with the sentence and the missing detail, so the model can look it
 * up or drop it. And every reply gets a grounding record the chat shows
 * beside it.
 *
 * Only the text is checked, never the truth: a model that copies a wrong
 * date out of a wrong source passes. That is the right trade for a check
 * that runs on every write in microseconds; see core grounding/citations.ts.
 */
import {
  type ChatMessage,
  DOCUMENT_WRITE_TOOLS,
  EVIDENCE_TOOLS,
  type EvidenceItem,
  type FactualLookupPreference,
  type GroundingEvidence,
  type MessageGrounding,
  PROSE_FILE_WRITE_TOOLS,
  type SentenceGrounding,
  type TextGrounding,
  WORKSPACE_SOURCE_READERS,
  createLogger,
  describeGroundingProblems,
  evidenceLabel,
  factualLookupTools,
  groundText,
  groundingProblems,
  isProseFile,
  parseCitationNumbers,
} from '@bendyline/gezel';
import type { ToolGroundingHooks } from '../providers/mcp-bridge.js';

const log = createLogger('grounding');

/** Refusals per write tool per turn before a write goes through with a warning. */
export const MAX_WRITE_REFUSALS = 2;

const EXCERPT_CHARS = 600;

function writeRefusalKey(tool: string, place: string): string {
  return `${tool}\u0000${place}`;
}

function isGroundingWriteRefusal(error: string | undefined): boolean {
  return /no source evidence has been collected|facts that no evidence in this conversation shows/i.test(
    error ?? '',
  );
}

interface Entry extends EvidenceItem {
  kind: 'retrieval' | 'tool';
  tool?: string;
  ref?: string;
}

/** `[3]`, `[1, 4]`, `[2-5]` with the space before them; the line structure is kept. */
const MARKER_WITH_SPACE = /[ \t]*\[\d{1,3}(?:\s*(?:[-–]|,)\s*\d{1,3})*\](?!\()/g;

/** Remove `[n]` markers from text bound for a document, keeping indentation and lines. */
export function removeCitationMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const stripped = line.replace(MARKER_WITH_SPACE, '');
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      return stripped.startsWith(indent) ? stripped : `${indent}${stripped.trimStart()}`;
    })
    .join('\n');
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const SOURCE_FILE_MENTION =
  /(?:^|[\s`'"(\[])((?:[\w-]+\/)*[\w-]+\.(?:md|markdown|txt|csv|tsv|json|ya?ml|html?|docx?|pdf|xlsx?|pptx?))(?=$|[\s`'"),.;:\]])/gi;

/** Up to four source files the conversation names, in order. */
export function mentionedSourceFiles(text: string): string[] {
  const files: string[] = [];
  for (const m of text.matchAll(SOURCE_FILE_MENTION)) {
    const file = m[1];
    if (file && !files.includes(file)) files.push(file);
    if (files.length === 4) break;
  }
  return files;
}

/** What a person would call this result, and what opens it. */
function describeToolEvidence(
  tool: string,
  args: Record<string, unknown>,
): { title?: string; ref?: string } {
  switch (tool) {
    case 'wikipedia_read': {
      const title = str(args.title) ?? str(args.page);
      return {
        ...(title ? { title: `Wikipedia: ${title}` } : {}),
        ...(str(args.url) ? { ref: str(args.url) } : {}),
      };
    }
    case 'fetch_url':
      return str(args.url) ? { title: str(args.url), ref: str(args.url) } : {};
    case 'read_document':
    case 'read_file':
    case 'read_artifact':
    case 'read_doc_as_markdown': {
      const ref = str(args.uri) ?? str(args.path) ?? str(args.name) ?? str(args.id);
      return ref ? { title: ref, ref } : {};
    }
    case 'read_files':
    case 'read_artifacts': {
      const paths = [
        ...(Array.isArray(args.paths) ? args.paths : []),
        ...(Array.isArray(args.files)
          ? args.files.map((f) => (f && typeof f === 'object' ? (f as { path?: unknown }).path : f))
          : []),
      ].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
      return paths.length > 0 ? { title: paths.join(', ') } : {};
    }
    case 'office_read_selection':
    case 'doc_read_selection':
    case 'sheet_read_selection':
      return { title: 'the selection in the open document' };
    case 'doc_read':
    case 'doc_search':
    case 'slide_read':
    case 'sheet_read_range':
    case 'sheet_describe_table':
      return { title: 'the open document' };
    default: {
      const query = str(args.query) ?? str(args.q);
      return query ? { title: `${tool} "${query}"` } : {};
    }
  }
}

interface StructuredToolEvidence {
  text: string;
  title: string;
  ref?: string;
}

/**
 * Split multi-result retrieval tools into citation-ready source cards. The
 * old single label made ten Wikipedia pages or five knowledge chunks all
 * share one evidence number, which small models then reused as though it
 * identified one source.
 */
function structuredToolEvidence(tool: string, text: string): StructuredToolEvidence[] {
  if (tool === 'read_files' || tool === 'read_artifacts') {
    // One `--- <path> (lines=…) ---` section per file: number each file on
    // its own so a citation names the memo it came from.
    const headers = [...text.matchAll(/^--- (.+?) \(lines=[^)\n]*\) ---$/gm)];
    return headers.flatMap((match, index) => {
      const path = match[1]?.trim();
      const start = (match.index ?? 0) + match[0].length;
      const end = headers[index + 1]?.index ?? text.length;
      const body = text.slice(start, end).trim();
      return path && body ? [{ text: body, title: path, ref: path }] : [];
    });
  }
  if (tool === 'search') {
    const rows: StructuredToolEvidence[] = [];
    const knowledgeRow = /^\[[^\]]*\bknowledge\b[^\]]*\]\s+(knowledge:\/\/\S+)\s+(.+)$/gim;
    for (const match of text.matchAll(knowledgeRow)) {
      const ref = match[1];
      const [rawTitle, ...snippetParts] = (match[2] ?? '').split(/\s+—\s+/);
      const title = rawTitle?.trim();
      if (!ref || !title) continue;
      rows.push({
        text: snippetParts.join(' — ').trim() || title,
        title,
        ref,
      });
    }
    return rows;
  }
  if (tool !== 'wikipedia_search' && tool !== 'web_search') return [];
  const starts = [...text.matchAll(/^\d+\.\s+\*\*(.+?)\*\*[^\n]*$/gm)];
  return starts.flatMap((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? text.length;
    const block = text.slice(start, end).trim();
    const urls = block.match(/https?:\/\/[^\s)>\]]+/g) ?? [];
    const ref = urls[urls.length - 1];
    const rawTitle = match[1]?.trim();
    if (!rawTitle) return [];
    return [
      {
        text: block,
        title: tool === 'wikipedia_search' ? `Wikipedia: ${rawTitle}` : rawTitle,
        ...(ref ? { ref } : {}),
      },
    ];
  });
}

/** The text a document write carries, as prose sentences. */
function documentWriteText(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'slide_insert') {
    const bullets = Array.isArray(args.bullets)
      ? args.bullets.filter((b): b is string => typeof b === 'string')
      : [];
    return [str(args.title) ?? '', ...bullets].filter(Boolean).join('\n');
  }
  return typeof args.text === 'string' ? args.text : null;
}

function withoutMarkers(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'slide_insert') {
    return {
      ...args,
      ...(typeof args.title === 'string'
        ? { title: removeCitationMarkers(args.title).trim() }
        : {}),
      ...(Array.isArray(args.bullets)
        ? {
            bullets: args.bullets.map((b) =>
              typeof b === 'string' ? removeCitationMarkers(b).trim() : b,
            ),
          }
        : {}),
    };
  }
  return typeof args.text === 'string' ? { ...args, text: removeCitationMarkers(args.text) } : args;
}

export class EvidenceLedger {
  private readonly entries = new Map<number, Entry>();
  private readonly byKey = new Map<string, number>();
  private next: number;
  /** Numbers at or below this were issued before this process: real, but their text is gone. */
  private readonly floor: number;
  private given = '';
  private turnStart: number;
  /** Consecutive refusals by write target, spanning task continuation turns. */
  private readonly refusals = new Map<string, number>();
  private readonly unverifiedWrites: SentenceGrounding[] = [];
  private readonly unverifiedPlaces = new Set<string>();
  private lookupTools: string[] = [];
  private readerTools: string[] = [];
  private lookupPreference: FactualLookupPreference = 'default';

  constructor(opts: { floor?: number } = {}) {
    this.floor = opts.floor ?? 0;
    this.next = this.floor + 1;
    this.turnStart = this.next;
  }

  /** Continue a session's numbering after a restart. */
  static fromMessages(messages: readonly ChatMessage[]): EvidenceLedger {
    let floor = 0;
    for (const message of messages) {
      for (const item of message.grounding?.evidence ?? []) floor = Math.max(floor, item.n);
    }
    const ledger = new EvidenceLedger({ floor });
    // Task continuations rebuild this object from the durable transcript.
    // Recover each target's consecutive grounding refusals or the bounded
    // guard silently restarts at zero on every continuation—the exact loop
    // it is meant to stop. Successful writes reset only their own target.
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        const place = PROSE_FILE_WRITE_TOOLS.has(call.name)
          ? call.path
          : DOCUMENT_WRITE_TOOLS.has(call.name)
            ? 'the document'
            : undefined;
        if (!place) continue;
        const key = writeRefusalKey(call.name, place);
        if (call.success) {
          ledger.refusals.delete(key);
        } else if (isGroundingWriteRefusal(call.errorMessage)) {
          const refused = ledger.refusals.get(key) ?? 0;
          ledger.refusals.set(key, Math.min(MAX_WRITE_REFUSALS, refused + 1));
        }
      }
    }
    return ledger;
  }

  /**
   * Start a turn. `given` is everything the person has said in the
   * session: their own facts need no citation.
   */
  beginTurn(given: string): void {
    this.given = given;
    this.turnStart = this.next;
    this.unverifiedWrites.length = 0;
    this.unverifiedPlaces.clear();
  }

  /** Number one piece of evidence; the same text from the same place keeps its number. */
  add(
    kind: Entry['kind'],
    text: string,
    meta: { title?: string; ref?: string; tool?: string } = {},
  ): number {
    const key = `${kind}\u0000${meta.tool ?? ''}\u0000${meta.ref ?? meta.title ?? ''}\u0000${text.length}\u0000${text.slice(0, 400)}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const n = this.next++;
    this.entries.set(n, { n, text, kind, ...meta });
    this.byKey.set(key, n);
    return n;
  }

  get size(): number {
    return this.entries.size;
  }

  check(text: string): TextGrounding {
    return groundText(text, [...this.entries.values()], {
      given: this.given,
      opaque: (n) => n <= this.floor,
    });
  }

  /** The `[n]` header for an evidence tool's result, or null for any other tool. */
  labelToolResult(tool: string, args: Record<string, unknown>, text: string): string | null {
    if (!EVIDENCE_TOOLS.has(tool) || !text.trim()) return null;
    const structured = structuredToolEvidence(tool, text);
    if (structured.length > 0) {
      return structured
        .map((item) => {
          const n = this.add('tool', item.text, {
            tool,
            title: item.title,
            ...(item.ref ? { ref: item.ref } : {}),
          });
          return evidenceLabel(n, tool, item.title);
        })
        .join('\n');
    }
    const meta = describeToolEvidence(tool, args);
    // A page read opens with its address (`wikipedia_read`: "# Title\nhttps://…").
    if (!meta.ref && (tool === 'wikipedia_read' || tool === 'fetch_url')) {
      const url = /^https?:\/\/\S+$/m.exec(text.slice(0, 600))?.[0];
      if (url) meta.ref = url;
    }
    const n = this.add('tool', text, { tool, ...meta });
    return evidenceLabel(n, tool, meta.title);
  }

  /**
   * Check text bound for the person's document. Refuses it while a
   * sentence states a detail no evidence shows, up to
   * {@link MAX_WRITE_REFUSALS} times per tool per turn; after that the
   * write goes through and the reply carries a warning, because a turn
   * that can never write anything is worse than one the person is told
   * to check. Markers are removed before the text reaches the document.
   */
  checkDocumentWrite(
    tool: string,
    args: Record<string, unknown>,
  ): { kind: 'reject'; error: string } | { kind: 'allow'; args: Record<string, unknown> } | null {
    if (!DOCUMENT_WRITE_TOOLS.has(tool)) return null;
    const text = documentWriteText(tool, args);
    if (!text?.trim()) return null;
    const refusal = this.refuseUngrounded(tool, this.check(text), {
      verb: 'inserted',
      again: 'insert again, citing each fact as [n]',
      place: 'the document',
    });
    return refusal ?? { kind: 'allow', args: withoutMarkers(tool, args) };
  }

  /**
   * Check a prose file before it is saved. `[n]` numbers mean nothing in a
   * file, so each fact is checked against all the evidence rather than what a
   * marker names, and the content is saved as written.
   */
  checkProseFileWrite(
    tool: string,
    args: Record<string, unknown>,
  ): { kind: 'reject'; error: string } | { kind: 'allow'; args: Record<string, unknown> } | null {
    if (!PROSE_FILE_WRITE_TOOLS.has(tool)) return null;
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!isProseFile(path) || typeof args.content !== 'string' || !args.content.trim()) return null;
    const refusal = this.refuseUngrounded(tool, this.check(removeCitationMarkers(args.content)), {
      verb: 'saved',
      again: 'save again',
      place: path!,
    });
    if (refusal) return refusal;
    const content = this.withSourceList(args.content);
    return content === args.content ? null : { kind: 'allow', args: { ...args, content } };
  }

  /**
   * A model told to name sources in files still writes `[3]`, and a reader
   * of the file has no conversation to look 3 up in. Give the numbers their
   * sources at the foot of the file, unless it already lists its own.
   */
  private withSourceList(original: string): string {
    if (/^#{1,6}\s*(?:sources|references|bibliography|bronnen)\b/im.test(original)) return original;
    // A marker for a number this session never issued points at nothing in
    // the file either; drop it rather than list a source that does not exist.
    const known = (n: number) => this.entries.has(n) || n <= this.floor;
    const content = original
      .split('\n')
      .map((line) =>
        line.replace(MARKER_WITH_SPACE, (marker) => {
          const inner = /\[([^\]]+)\]/.exec(marker)?.[1] ?? '';
          return parseCitationNumbers(inner).some(known) ? marker : '';
        }),
      )
      .join('\n');
    const cited = new Set<number>();
    for (const sentence of this.check(content).sentences) {
      for (const n of sentence.cites) if (this.entries.has(n)) cited.add(n);
    }
    if (cited.size === 0) return content;
    const lines = [...cited]
      .sort((a, b) => a - b)
      .map((n) => {
        const entry = this.entries.get(n)!;
        const name = entry.title ?? entry.ref ?? `Result of ${entry.tool ?? 'a search'}`;
        const link = entry.ref && entry.ref !== name ? ` — ${entry.ref}` : '';
        return `[${n}] ${name}${link}`;
      });
    return `${content.trimEnd()}\n\n## Sources\n\n${lines.join('\n')}\n`;
  }

  /**
   * What to do about a refused write. Gemma 4 31B, told only to "look it
   * up", told the person it had no sources and asked for some, with
   * `wikipedia_search` on its roster; naming the tools, and the next call,
   * is what turns a refusal into research.
   */
  private remedy(again: string, target?: string): string {
    const reread = this.workspaceReread(target);
    if (reread) {
      const others =
        this.lookupTools.length > 0
          ? ` (for anything the project files do not hold: ${this.lookupTools.map((t) => `\`${t}\``).join(', ')})`
          : '';
      return `Do not ${again} yet. Your next tool call must be \`${reread.reader}\` on the source file that states the missing detail${reread.files}${others}. Use what it returns before writing again. Remove anything the files do not support, or say in the text that it could not be verified.`;
    }
    const [first, ...rest] = this.lookupTools;
    if (!first) {
      return `Remove each of these, or say in the text that it could not be verified, then ${again}. If the person can give you a source, ask for it.`;
    }
    const others = rest.length > 0 ? ` (also: ${rest.map((t) => `\`${t}\``).join(', ')})` : '';
    const call =
      this.lookupPreference === 'knowledge' && first === 'search'
        ? '`search({ query: "<subject>", sources: ["knowledge"] })`'
        : `\`${first}\``;
    return `Do not ${again} yet. Your next tool call must be ${call} for the missing subject${others}. Use its returned evidence before writing again. Remove anything the results do not support, or say in the text that it could not be verified. Do not ask the person for sources you can look up yourself.`;
  }

  /**
   * A writer that has collected no evidence cannot repair a rejected factual
   * write by trying the same write again. Keep this deliberately shorter than
   * the first refusal: tiny models attend better to one forced next action.
   */
  private researchFirstRemedy(tool: string, target?: string): string {
    const reread = this.workspaceReread(target);
    if (reread) {
      return `Not saved: no source evidence has been collected. Do not call \`${tool}\` again yet. Your next tool call must be \`${reread.reader}\`${reread.files}. Use what it returns before writing.`;
    }
    const first = this.lookupTools[0];
    if (!first) return this.remedy('write again', target);
    const call =
      this.lookupPreference === 'knowledge' && first === 'search'
        ? '`search({ query: "<subject>", sources: ["knowledge"] })`'
        : `\`${first}\``;
    return `Not saved: no source evidence has been collected. Do not call \`${tool}\` again yet. Your next tool call must be ${call}. Use its returned evidence before writing.`;
  }

  /**
   * The reader to name when this writer's sources are project files: its
   * evidence so far came from a workspace reader, or the conversation names
   * the files. Sending such a writer to `search` re-acquires text it already
   * had, or finds nothing: 92 recoveries narrowed to `search` across 28
   * workspace-sourced trials before this existed (2026-10-06 review).
   */
  private workspaceReread(target?: string): { reader: string; files: string } | null {
    const reader = this.readerTools[0];
    if (!reader) return null;
    const read = [...this.entries.values()]
      .filter((e) => e.tool !== undefined && WORKSPACE_SOURCE_READERS.includes(e.tool))
      .map((e) => e.ref ?? e.title)
      .filter((p): p is string => typeof p === 'string' && p !== '');
    const isTarget = (f: string) =>
      target !== undefined && f.split('/').pop() === target.split('/').pop();
    const named = mentionedSourceFiles(this.given).filter((f) => !isTarget(f));
    if (read.length === 0 && named.length === 0) return null;
    const files = [...new Set([...read, ...named])].filter((f) => !isTarget(f)).slice(0, 4);
    return {
      reader,
      files: files.length > 0 ? ` (${files.map((f) => `\`${f}\``).join(', ')})` : '',
    };
  }

  /** The lookup tools this session has, in the order to try them. */
  setLookupTools(
    toolNames: Iterable<string>,
    preference: FactualLookupPreference = 'default',
  ): void {
    const available = new Set(toolNames);
    this.lookupPreference = preference;
    this.lookupTools = factualLookupTools(available, preference);
    this.readerTools = WORKSPACE_SOURCE_READERS.filter((t) => available.has(t));
  }

  /**
   * Refuse a write whose sentences state facts no evidence shows, up to
   * {@link MAX_WRITE_REFUSALS} times per tool per turn; after that it goes
   * through and the reply says so.
   */
  private refuseUngrounded(
    tool: string,
    grounding: TextGrounding,
    words: { verb: string; again: string; place: string },
  ): { kind: 'reject'; error: string } | null {
    const refusalKey = writeRefusalKey(tool, words.place);
    const problems = groundingProblems(grounding);
    if (problems.length === 0) {
      this.refusals.delete(refusalKey);
      return null;
    }
    const refused = this.refusals.get(refusalKey) ?? 0;
    // At zero evidence, a detailed sentence-by-sentence critique invites a
    // model to redraft from memory. Give the only productive next action on
    // the first rejection. Keep counting these attempts so that once evidence
    // arrives the ordinary bounded guard can still fail open instead of
    // trapping a long-running task.
    if (
      this.entries.size === 0 &&
      (this.lookupTools.length > 0 || this.workspaceReread(words.place) !== null)
    ) {
      this.refusals.set(refusalKey, Math.min(MAX_WRITE_REFUSALS, refused + 1));
      log.warn(`${tool} blocked: no evidence collected`);
      return { kind: 'reject', error: this.researchFirstRemedy(tool, words.place) };
    }
    if (refused < MAX_WRITE_REFUSALS) {
      this.refusals.set(refusalKey, refused + 1);
      log.info(
        `refused ${tool}: ${problems.length} ungrounded sentence(s) (refusal ${refused + 1}/${MAX_WRITE_REFUSALS})`,
      );
      return {
        kind: 'reject',
        error: [
          `Not ${words.verb}: ${problems.length === 1 ? 'one sentence states' : `${problems.length} sentences state`} facts that no evidence in this conversation shows.`,
          describeGroundingProblems(problems),
          this.remedy(words.again, words.place),
        ].join('\n'),
      };
    }
    log.warn(`${tool} wrote ${problems.length} ungrounded sentence(s) after ${refused} refusals`);
    // A later rewrite must earn its own bounded set of checks. This also
    // keeps an unrelated request in a later turn from inheriting a permanently
    // fail-open tool merely because it writes to the same path.
    this.refusals.delete(refusalKey);
    this.unverifiedWrites.push(...problems);
    this.unverifiedPlaces.add(words.place);
    return null;
  }

  /** Bridge hooks for every bridge in the session. */
  hooks(): ToolGroundingHooks {
    return {
      checkWrite: (tool, args) =>
        this.checkDocumentWrite(tool, args) ?? this.checkProseFileWrite(tool, args),
      labelEvidence: (tool, args, text) => this.labelToolResult(tool, args, text),
    };
  }

  /**
   * Sentences written into the document unverified since the last call.
   * A turn can commit several assistant messages; each write is reported
   * on exactly one of them.
   */
  takeUnverifiedWrites(): { sentences: SentenceGrounding[]; places: string[] } {
    const places = [...this.unverifiedPlaces];
    this.unverifiedPlaces.clear();
    return { sentences: this.unverifiedWrites.splice(0), places };
  }

  /**
   * The grounding record for a reply: the evidence it cites plus whatever
   * the turn added, what the check found in it, and any `unverifiedWrites`
   * the reply is reporting.
   */
  grounding(
    reply: string,
    unverifiedWrites: readonly SentenceGrounding[] = [],
  ): MessageGrounding | undefined {
    const result = this.check(reply);
    const cited = new Set(result.sentences.flatMap((s) => s.cites));
    const shown = [...this.entries.values()].filter((e) => cited.has(e.n) || e.n >= this.turnStart);
    if (shown.length === 0 && cited.size === 0 && unverifiedWrites.length === 0) return undefined;
    const evidence: GroundingEvidence[] = shown
      .sort((a, b) => a.n - b.n)
      .map((e) => ({
        n: e.n,
        kind: e.kind,
        ...(e.title ? { title: e.title.slice(0, 300) } : {}),
        ...(e.ref ? { ref: e.ref.slice(0, 1000) } : {}),
        ...(e.tool ? { tool: e.tool } : {}),
        excerpt: e.text.slice(0, EXCERPT_CHARS),
      }));
    const problems = [...unverifiedWrites, ...groundingProblems(result)].slice(0, 20);
    return {
      evidence,
      counts: {
        supported: result.counts.supported,
        cited: result.counts.cited,
        unattributed: result.counts.unattributed,
        uncited: result.counts.uncited,
        unsupported: result.counts.unsupported,
        badCitation: result.counts['bad-citation'],
      },
      problems: problems.map((p) => ({
        text: p.text.slice(0, 500),
        status: p.status as 'uncited' | 'unsupported' | 'bad-citation',
        missing: p.missing.slice(0, 12),
      })),
    };
  }
}
