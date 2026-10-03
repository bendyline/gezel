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
  type GroundingEvidence,
  type MessageGrounding,
  PROSE_FILE_WRITE_TOOLS,
  type SentenceGrounding,
  type TextGrounding,
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
  private readonly refusals = new Map<string, number>();
  private readonly unverifiedWrites: SentenceGrounding[] = [];
  private readonly unverifiedPlaces = new Set<string>();
  private lookupTools: string[] = [];

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
    return new EvidenceLedger({ floor });
  }

  /**
   * Start a turn. `given` is everything the person has said in the
   * session: their own facts need no citation.
   */
  beginTurn(given: string): void {
    this.given = given;
    this.turnStart = this.next;
    this.refusals.clear();
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
  private remedy(again: string): string {
    const [first, ...rest] = this.lookupTools;
    if (!first) {
      return `Remove each of these, or say in the text that it could not be verified, then ${again}. If the person can give you a source, ask for it.`;
    }
    const others = rest.length > 0 ? ` (also: ${rest.map((t) => `\`${t}\``).join(', ')})` : '';
    return `You can look these up: call \`${first}\` now for the subject${others}. Then write only what the results show and ${again}. Leave out anything you cannot find, or say in the text that it could not be verified. Do not ask the person for sources you can look up yourself.`;
  }

  /** The lookup tools this session has, in the order to try them. */
  setLookupTools(toolNames: Iterable<string>): void {
    this.lookupTools = factualLookupTools(toolNames);
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
    const problems = groundingProblems(grounding);
    if (problems.length === 0) return null;
    const refused = this.refusals.get(tool) ?? 0;
    if (refused < MAX_WRITE_REFUSALS) {
      this.refusals.set(tool, refused + 1);
      log.info(
        `refused ${tool}: ${problems.length} ungrounded sentence(s) (refusal ${refused + 1}/${MAX_WRITE_REFUSALS})`,
      );
      return {
        kind: 'reject',
        error: [
          `Not ${words.verb}: ${problems.length === 1 ? 'one sentence states' : `${problems.length} sentences state`} facts that no evidence in this conversation shows.`,
          describeGroundingProblems(problems),
          this.remedy(words.again),
        ].join('\n'),
      };
    }
    log.warn(`${tool} wrote ${problems.length} ungrounded sentence(s) after ${refused} refusals`);
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
