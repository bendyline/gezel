/**
 * Async memory extraction. After each assistant turn completes, we send the
 * last few turns to the LLM to extract facts worth remembering. This is
 * fire-and-forget — it never blocks the chat.
 */

import { type ChatMessage, createLogger } from '@bendyline/gezel';
import { type MemoryKind, isMemoryKind } from './daily-markdown.js';
import { EmbeddingsDisabledError } from './embeddings.js';
import type { MemoryManager } from './manager.js';

const log = createLogger('memory');

/**
 * The prompt's opening sentence, kept separate so the same string can be used
 * to recognise a reply that is simply the prompt handed back.
 */
const EXTRACT_PROMPT_OPENER =
  'You are a memory extraction system. Look at the conversation below and extract anything worth remembering for future conversations.';

/**
 * Few-shot examples, held as data rather than buried in the prompt prose so
 * the identical list can reject them on the way back in.
 *
 * They are correctly-tagged memory lines, which is the point — and the trap.
 * A model that echoes its instructions instead of answering (a weak local
 * model, or any mock provider) hands these four back, they parse perfectly,
 * and gezel's own documentation examples land in the user's memory as things
 * their crew remembered. They then ride into later prompts as recalled
 * context, so a project that never mentioned sqlite-vec is told it chose it.
 * Wild-caught in unified search, where "Sessions are stored as JSON files
 * under the data directory." came back four times over for an unrelated query.
 */
const EXTRACT_EXAMPLES = [
  'PROJECT/FACT: Sessions are stored as JSON files under the data directory.',
  'PROJECT/DECISION: Chose sqlite-vec over Vectra for the memory index.',
  'GEZEL/PREF: The user prefers terse replies without emojis.',
  'PROJECT/STATUS: The OpenAI API key is currently missing from config.',
] as const;

const EXTRACT_PROMPT = `${EXTRACT_PROMPT_OPENER}

Every line of your reply must start with a tag in the form SCOPE/KIND: followed by one concise sentence.

SCOPE is one of:
- PROJECT — specific to this project: its facts, decisions, current state.
- GEZEL — transferable to any project: the user's general preferences, lessons about how to work well.

KIND is one of:
- FACT — a durable fact (paths, names, architecture, who/what/where).
- DECISION — a choice that was made, and why.
- PREF — a preference or working style.
- STATUS — a temporary condition that is true right now.

Examples:
${EXTRACT_EXAMPLES.join('\n')}

Rules:
- Extract ONLY genuinely useful information; skip greetings, small talk, and trivial exchanges.
- Do NOT record task or project completion or progress (e.g. "the feature is done", "the project is complete") — the task system already tracks that. Use STATUS only for other temporary conditions.
- Only extract from the new messages; any earlier context shown is for reference.
- One memory per line, no bullets or numbering.
- If there's nothing worth remembering, respond with exactly: NONE

Conversation:
`;

export interface TaggedMemory {
  scope: 'gezel' | 'project';
  kind: MemoryKind;
  text: string;
}

const FULL_TAG_RE = /^(PROJECT|GEZEL)\s*\/\s*(FACT|DECISION|PREF|STATUS)\s*:\s*(.+)$/i;
const KIND_TAG_RE = /^(FACT|DECISION|PREF|STATUS)\s*:\s*(.+)$/i;

/**
 * Parse one extracted line into its routed scope + kind. Tolerant by
 * design — small local models routinely ignore the tag format, so:
 * leading bullets/numbering are stripped (despite the prompt forbidding
 * them), a kind-only tag routes by the same rule the prompt teaches
 * (PREF is transferable → gezel; everything else → project), and a fully
 * untagged line falls back to project/fact rather than being dropped.
 */
export function parseExtractedLine(raw: string): TaggedMemory | null {
  const line = raw.replace(/^[-*\d.\s]+/, '').trim();
  if (!line || line === 'NONE') return null;

  const full = line.match(FULL_TAG_RE);
  if (full) {
    const kind = full[2]!.toLowerCase();
    return {
      scope: full[1]!.toLowerCase() as 'gezel' | 'project',
      kind: isMemoryKind(kind) ? kind : 'fact',
      text: full[3]!.trim(),
    };
  }

  const kindOnly = line.match(KIND_TAG_RE);
  if (kindOnly) {
    const kind = kindOnly[1]!.toLowerCase();
    return {
      scope: kind === 'pref' ? 'gezel' : 'project',
      kind: isMemoryKind(kind) ? kind : 'fact',
      text: kindOnly[2]!.trim(),
    };
  }

  return { scope: 'project', kind: 'fact', text: line };
}

/** Normalized text of every few-shot example, for rejecting echoes of them. */
const EXAMPLE_TEXTS: ReadonlySet<string> = new Set(
  EXTRACT_EXAMPLES.map((line) => parseExtractedLine(line)?.text.trim().toLowerCase()).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  ),
);

/**
 * True when the reply is the prompt coming back rather than an answer.
 *
 * The untagged-line fallback treats any prose as a project fact, so an echoed
 * prompt does not merely contribute its four examples — every heading and
 * rule ("Examples:", "Rules:", "SCOPE is one of:") is stored as something the
 * crew remembered. Recognising the echo wholesale is the only cheap way to
 * reject all of it, and no genuine memory quotes the extractor's own opener.
 */
function looksLikePromptEcho(reply: string): boolean {
  return reply.includes(EXTRACT_PROMPT_OPENER);
}

/**
 * Run a self-contained one-shot completion on the same provider as the
 * chat session. Must NOT share state with the live chat session — the
 * extraction prompt + reply would otherwise pollute the conversation
 * history (Ollama's `messages` array is the worst case: every turn
 * accumulates an `EXTRACT_PROMPT` user message + a `NONE` assistant
 * reply, which silently context-poisons the model and eventually
 * makes it mimic the "NONE" pattern as its own chat replies).
 *
 * `ChatManager.oneShotCompletion` satisfies this contract — it
 * creates a throwaway session with a minimal system prompt and
 * disconnects after.
 */
export type OneShotRunner = (prompt: string, timeoutMs: number) => Promise<string>;

/** Messages before the cursor included as read-only context. */
const EXTRACT_CONTEXT_MESSAGES = 2;
/**
 * Char budget for the rendered transcript. Heavy providers accrue 10+
 * messages between extractions (more after a defer-cap burst); walk
 * newest-first so the tail survives truncation, like the summarizer's
 * renderTranscript. Context messages are the first to be dropped.
 */
const EXTRACT_CHAR_BUDGET = 16_000;

export interface ExtractMemoriesArgs {
  /** Full transcript snapshot. */
  messages: ChatMessage[];
  /**
   * Extraction cursor — messages before this index were already
   * extracted in an earlier pass and are only eligible as read-only
   * context. Pass 0 when unset.
   */
  extractedUpTo: number;
  oneShot: OneShotRunner;
  memory: MemoryManager;
  gezelId: string;
  projectId: string;
  debug?: { isEnabled(): boolean };
}

function renderMessages(messages: ChatMessage[], budget: number): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const line = `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`;
    if (chars + line.length > budget) {
      lines.unshift(`(… ${i + 1} earlier message(s) truncated for length …)`);
      break;
    }
    lines.unshift(line);
    chars += line.length + 2;
  }
  return lines.join('\n\n');
}

export async function extractMemories(args: ExtractMemoriesArgs): Promise<void> {
  const { messages, oneShot, memory, gezelId, projectId, debug } = args;

  const cursor = Math.min(Math.max(0, args.extractedUpTo), messages.length);
  const fresh = messages.slice(cursor);
  if (messages.length < 2 || fresh.length === 0) return;
  const context = messages.slice(Math.max(0, cursor - EXTRACT_CONTEXT_MESSAGES), cursor);

  const freshText = renderMessages(fresh, EXTRACT_CHAR_BUDGET);
  const contextText =
    context.length > 0
      ? renderMessages(context, Math.max(0, EXTRACT_CHAR_BUDGET - freshText.length))
      : '';

  const conversationText = contextText
    ? `Earlier context (for reference only — do NOT extract memories from these messages):\n\n${contextText}\n\nNew messages:\n\n${freshText}`
    : `New messages:\n\n${freshText}`;

  try {
    const content = (await oneShot(`${EXTRACT_PROMPT}${conversationText}`, 30_000)).trim();
    if (!content || content === 'NONE') return;
    if (looksLikePromptEcho(content)) {
      log.warn('[memory] extraction reply echoed the prompt; storing nothing for this turn');
      return;
    }

    const parsed = content
      .split('\n')
      .map(parseExtractedLine)
      .filter((m): m is TaggedMemory => m !== null)
      // A partial echo still hands back the examples verbatim. They parse
      // cleanly, so nothing downstream would catch them.
      .filter((m) => !EXAMPLE_TEXTS.has(m.text.trim().toLowerCase()));
    let saved = 0;
    let deduped = 0;
    for (const m of parsed) {
      // Route by classification: transferable lines to the gezel's own
      // memory, project-specific lines to the shared project memory.
      const targetId = m.scope === 'gezel' ? gezelId : projectId;
      const outcome = await memory.save(m.scope, targetId, m.text, m.kind);
      if (outcome?.status === 'duplicate') deduped++;
      else saved++;
    }
    log.info(`[memory] extracted ${saved} memories (${deduped} duplicate(s) skipped)`);
    if (debug?.isEnabled()) {
      for (const m of parsed) {
        const preview = m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text;
        log.info(`[memory] · [${m.scope}/${m.kind}] ${preview}`);
      }
    }
  } catch (err) {
    // Once the embedding pipeline is known-broken on this platform, stay
    // silent — `getPipeline()` already printed the fix command on first
    // failure, and we don't want one stack-trace per chat turn.
    if (err instanceof EmbeddingsDisabledError) return;
    log.warn('[memory] extraction failed:', err instanceof Error ? err.message : err);
  }
}
