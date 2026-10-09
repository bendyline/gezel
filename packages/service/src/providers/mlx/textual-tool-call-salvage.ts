import { createLogger } from '@bendyline/gezel';
import {
  findBareInvokeToolCallSpans,
  findClaudeInvokeToolCallSpans,
  findGlmToolCallSpans,
  findHermesFunctionToolCallSpans,
  findHermesFunctionToolCallSpansLenient,
  findProseToolCallSpans,
  findShellToolCallSpans,
  findTruncatedJsonEnvelope,
  findUnrecognizedToolEnvelope,
  findXmlTagToolCallSpans,
  isPayloadMutationToolName,
  isWriteShapedToolName,
  parseJsonEnvelopeToolCalls,
  salvageWriteShapedTruncation,
  stripBareInvokeToolCallsFromText,
  stripClaudeInvokeToolCallsFromText,
  stripGlmToolCallsFromText,
  stripHermesFunctionToolCallsFromText,
  stripJsonEnvelopesFromText,
  stripProseToolCallsFromText,
  stripShellToolCallsFromText,
  stripXmlTagToolCallsFromText,
} from '../local-tool-call-salvage.js';
import type { MlxToolCallAccumulator } from './tool-call-protocol.js';

const log = createLogger('mlx');

type SalvagedToolCalls = ReturnType<MlxToolCallAccumulator['finalize']>;

/** What the textual passes recovered from one generation, by the shape that matched. */
export interface TextualToolCallSalvage {
  /** The visible text with every salvaged call (and a truncated tail) stripped. */
  turnContent: string;
  proseRepaired: SalvagedToolCalls;
  xmlTagRepaired: SalvagedToolCalls;
  claudeInvokeRepaired: SalvagedToolCalls;
  glmRepaired: SalvagedToolCalls;
  hermesRepaired: SalvagedToolCalls;
  shellRepaired: SalvagedToolCalls;
  envelopeRepaired: SalvagedToolCalls;
  envelopeTruncated: ReturnType<typeof findTruncatedJsonEnvelope>;
  /** A JSON envelope naming a tool this turn does not have. */
  unknownCall: { wanted: string; suggestion: string | null } | null;
  truncatedSalvage: SalvagedToolCalls;
  bareInvokeRepaired: SalvagedToolCalls;
}

/**
 * The salvage passes that read tool calls out of a generation's visible text,
 * run after the structured calls and the stripped-marker repair. Each pass is
 * gated on every earlier one having found nothing, so one intent never fires
 * twice. Truncated calls are reported through `truncatedCallIds` and
 * `droppedTruncatedPayloadCalls`, which the tool loop reads afterwards.
 */
export function salvageTextualToolCalls(input: {
  turnContent: string;
  knownToolNames: Set<string>;
  seq: number;
  turn: number;
  structuredCalls: SalvagedToolCalls;
  repairedCalls: SalvagedToolCalls;
  codeBlockRepaired: SalvagedToolCalls;
  truncatedCallIds: Set<string>;
  droppedTruncatedPayloadCalls: Array<{ name: string; args: Record<string, unknown> }>;
  emitWarning: (message: string) => void;
}): TextualToolCallSalvage {
  const {
    knownToolNames,
    seq,
    turn,
    structuredCalls,
    repairedCalls,
    codeBlockRepaired,
    truncatedCallIds,
    droppedTruncatedPayloadCalls,
    emitWarning,
  } = input;
  let turnContent = input.turnContent;
  let unknownCall: { wanted: string; suggestion: string | null } | null = null;
  // Third salvage path: small models sometimes emit
  // `name(args)` directly in their text — usually inside a
  // markdown code block — instead of issuing a real
  // function-call. The stripper misses it (no `<|tool_call|>`
  // markers) and the user sees the call rendered as decoration
  // while nothing happens. If no real or marker-repaired calls
  // fired this turn, scan the streamed text for a prose-shaped
  // call and promote it. Strict gating (known-tools set + JSON
  // parse) prevents false positives.
  const proseRepaired: typeof structuredCalls = [];
  if (structuredCalls.length === 0 && repairedCalls.length === 0 && turnContent.length > 0) {
    const parsedSpans = findProseToolCallSpans(turnContent, knownToolNames);
    for (const [idx, parsed] of parsedSpans.entries()) {
      proseRepaired.push({
        id: `prose-repair-${seq}-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    }
    if (parsedSpans.length > 0) {
      // Strip every prose body (and any wrapping ```fence```)
      // so the persisted assistant bubble doesn't show the
      // calls as decoration alongside the actual tool widgets.
      turnContent = stripProseToolCallsFromText(turnContent, parsedSpans);
    } else if (/[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(turnContent)) {
      // Diagnostic: the content has SHAPE that looks like a
      // tool call (an identifier followed by `(`) but the
      // salvage parser found nothing. Surface a debug-level
      // preview so a regression here is visible in the daemon
      // log without re-running the whole eval. The match
      // could be JS / Python / prose narration — the regex
      // alone isn't enough to promote, but it's a strong
      // signal that the parser missed something the model
      // intended as a call.
      const match = turnContent.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
      const wanted = match?.[1] ?? '?';
      const headPos = Math.max(0, (match?.index ?? 0) - 40);
      const preview = turnContent.slice(headPos, headPos + 240).replace(/\s+/g, ' ');
      log.debug(
        `turn#${seq}.${turn} prose-salvage found 0 spans despite \`${wanted}(\`-shaped text — preview: ${preview}`,
      );
    }
  }
  // Fourth salvage path: Anthropic-style XML self-closing tags
  // (`<browser_navigate url="..." />`). Wild-caught on Qwen 3.6
  // 27B at MLX after the `<|tool_call|>` channel was closed off
  // via prompt — the model picks the next-most-familiar tool-use
  // shape from training data. Run before the JSON envelope
  // salvage so a tag like `<list_projects />` isn't mis-parsed
  // by the JSON walker.
  const xmlTagRepaired: typeof structuredCalls = [];
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const xmlSpans = findXmlTagToolCallSpans(turnContent, knownToolNames);
    for (const [idx, parsed] of xmlSpans.entries()) {
      xmlTagRepaired.push({
        id: `xml-tag-repair-${seq}-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    }
    if (xmlSpans.length > 0) {
      turnContent = stripXmlTagToolCallsFromText(turnContent, xmlSpans);
    }
  }
  // Anthropic-style `<function_calls><invoke name="X">...</invoke></function_calls>`
  // markup. The literal Claude tool-use XML format that Qwen
  // 3.6 reaches for after the simpler self-closing XML form is
  // closed off. Parameters arrive as nested
  // `<parameter name="K">value</parameter>` elements.
  const claudeInvokeRepaired: typeof structuredCalls = [];
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const invokeSpans = findClaudeInvokeToolCallSpans(turnContent, knownToolNames);
    for (const [idx, parsed] of invokeSpans.entries()) {
      claudeInvokeRepaired.push({
        id: `claude-invoke-repair-${seq}-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    }
    if (invokeSpans.length > 0) {
      turnContent = stripClaudeInvokeToolCallsFromText(turnContent, invokeSpans);
    }
  }
  // GLM-4.5/4.6 native `<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>`
  // markup. GLM-family models (laguna-s-118b, a GLM-4.5-Air
  // derivative) emit this verbatim as content on the MLX textual
  // path — no `<function=`, no `="`, so none of the shapes above
  // match it and the turn stalls with zero tool calls. Run before
  // the Hermes/shell paths (both key on `<tool_call>` too, but on
  // `<function=` / `name key="value"` bodies GLM never produces).
  const glmRepaired: typeof structuredCalls = [];
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const glmSpans = findGlmToolCallSpans(turnContent, knownToolNames);
    for (const [idx, parsed] of glmSpans.entries()) {
      if (parsed.truncated && !isWriteShapedToolName(parsed.name)) {
        emitWarning(
          `The model's \`${parsed.name}\` call was cut off mid-stream and was skipped so a partial mutation could not land. Retry with a smaller payload.`,
        );
        if (isPayloadMutationToolName(parsed.name)) {
          droppedTruncatedPayloadCalls.push({ name: parsed.name, args: parsed.arguments });
        }
        continue;
      }
      const id = `glm-repair-${seq}-${turn}-${idx}`;
      glmRepaired.push({
        id,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
      if (parsed.truncated) truncatedCallIds.add(id);
    }
    if (glmSpans.length > 0) {
      turnContent = stripGlmToolCallsFromText(turnContent, glmSpans);
    }
  }
  // Hermes-2-Pro / Functionary `<function=NAME><parameter=K>V</parameter></function>`
  // markup, often wrapped in Qwen's canonical `<tool_call>`
  // envelope (Qwen 3.6 has been trained on both corpora and at
  // heavy quant mixes them).
  const hermesRepaired: typeof structuredCalls = [];
  // Ids of synthesized tool calls whose underlying salvage span
  // was marked `truncated` — the bridge will execute them with
  // whatever content arrived, then we'll append an
  // auto-continuation hint to the tool's result so the model
  // knows to call the tool again with the remaining bytes.
  // Cleared and rebuilt every iteration; consumed in the
  // tool-execution loop further down.
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    glmRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    let hermesSpans = findHermesFunctionToolCallSpans(turnContent, knownToolNames);
    if (hermesSpans.length === 0 && /<function=/i.test(turnContent)) {
      // Streaming-truncated case (Qwen 3.6 27B write_file bodies
      // that exceed max_tokens): the strict regex needs
      // `</parameter>` + `</function>` closers, the lenient
      // parser accepts the open-only shape and extends the last
      // parameter value to EOF. Gated on the cheap text-contains
      // check so prose unrelated to tool calls isn't re-scanned.
      const lenient = findHermesFunctionToolCallSpansLenient(turnContent, knownToolNames);
      if (lenient.length > 0) {
        log.info(
          `turn#${seq}.${turn} salvaged ${lenient.length} Hermes-style tool call(s) via lenient parser (truncated stream): ${lenient.map((s) => s.name).join(', ')}`,
        );
        hermesSpans = lenient;
      }
    }
    for (const [idx, parsed] of hermesSpans.entries()) {
      if (parsed.truncated && !isWriteShapedToolName(parsed.name)) {
        emitWarning(
          `The model's \`${parsed.name}\` call was cut off mid-stream and was skipped so a partial mutation could not land. Retry with a smaller payload.`,
        );
        if (isPayloadMutationToolName(parsed.name)) {
          droppedTruncatedPayloadCalls.push({ name: parsed.name, args: parsed.arguments });
        }
        continue;
      }
      const id = `hermes-repair-${seq}-${turn}-${idx}`;
      hermesRepaired.push({
        id,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
      if (parsed.truncated) truncatedCallIds.add(id);
    }
    if (hermesSpans.length > 0) {
      turnContent = stripHermesFunctionToolCallsFromText(turnContent, hermesSpans);
    }
  }
  // Shell-style `<tool_call>name key="value"` per line, no
  // close tag, no JSON envelope. The most degraded form of
  // Qwen's canonical `<tool_call>` template — wild-caught on
  // Qwen 3.6 27B at heavy quant after the canonical, XML, and
  // Claude-invoke shapes were all closed off via prompt.
  const shellRepaired: typeof structuredCalls = [];
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    glmRepaired.length === 0 &&
    hermesRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const shellSpans = findShellToolCallSpans(turnContent, knownToolNames);
    for (const [idx, parsed] of shellSpans.entries()) {
      shellRepaired.push({
        id: `shell-repair-${seq}-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    }
    if (shellSpans.length > 0) {
      turnContent = stripShellToolCallsFromText(turnContent, shellSpans);
    }
  }
  // Fifth salvage path: JSON-envelope shape some small models
  // (Qwen 3.5/3.6) emit verbatim — `{"tool": "X", "args": {}}`
  // typically inside a markdown json fence — instead of a real
  // `tool_calls` event. Promote it the same way as the prose
  // salvage. Gated on no other salvage having fired so we don't
  // double-issue when the model coincidentally emitted both.
  //
  // We extract *every* envelope in the streamed content (Qwen
  // sometimes chains multiple back-to-back) and surface a
  // truncation warning when the model stopped mid-envelope —
  // both fixes for the user-visible "only the first call fires
  // and then it stops" symptom.
  const envelopeRepaired: typeof structuredCalls = [];
  let envelopeTruncated: ReturnType<typeof findTruncatedJsonEnvelope> = null;
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    glmRepaired.length === 0 &&
    hermesRepaired.length === 0 &&
    shellRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const parsedCalls = parseJsonEnvelopeToolCalls(turnContent, knownToolNames);
    envelopeTruncated = findTruncatedJsonEnvelope(turnContent);
    for (const [idx, parsed] of parsedCalls.entries()) {
      envelopeRepaired.push({
        id: `json-envelope-repair-${seq}-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    }
    if (envelopeRepaired.length > 0 || envelopeTruncated) {
      // Strip every salvaged envelope (and any truncated tail)
      // from visible content so the user doesn't see the call
      // body rendered alongside the actual tool bubbles.
      turnContent = stripJsonEnvelopesFromText(
        turnContent,
        parsedCalls,
        envelopeTruncated?.matchStart,
      );
    }
  }
  // Hide unrecognized-name JSON envelopes from the bubble even
  // though we can't promote them. The downstream "Did you mean…?"
  // branch will retry on the model's behalf; surfacing the failed
  // first attempt as raw JSON in the user's view is just noise.
  // Detection is done here (vs. inside the retry branch below)
  // so the strip runs before `fullText += turnContent`.
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    glmRepaired.length === 0 &&
    hermesRepaired.length === 0 &&
    shellRepaired.length === 0 &&
    envelopeRepaired.length === 0 &&
    !envelopeTruncated &&
    turnContent.length > 0
  ) {
    const miss = findUnrecognizedToolEnvelope(turnContent, knownToolNames);
    unknownCall = miss;
    if (miss) {
      turnContent = stripJsonEnvelopesFromText(turnContent, [
        { matchStart: miss.matchStart, matchEnd: miss.matchEnd },
      ]);
    }
  }
  // Truncation-with-partial-args salvage. When the model started
  // a write-shaped call (`write_file`, `write_artifact`,
  // `append_to_file`) but the stream ended mid-content, promote
  // the partial body to a synthesized tool_call so the bytes
  // we DID receive land on disk — and tag the call id as
  // truncated so the tool-result auto-continuation hint below
  // tells the model to issue `append_to_file` for the missing
  // tail. Shared logic with Ollama + llama-cpp providers via
  // {@link salvageWriteShapedTruncation}.
  //
  // Gating: only fires when NO other salvage produced a call
  // for this iteration (otherwise we'd double-fire the same
  // intent).
  const truncatedSalvage: typeof structuredCalls = [];
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    glmRepaired.length === 0 &&
    hermesRepaired.length === 0 &&
    shellRepaired.length === 0 &&
    envelopeRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const salvage = salvageWriteShapedTruncation(
      turnContent,
      knownToolNames,
      `truncated-salvage-mlx-${seq}-${turn}`,
    );
    if (salvage.synthesizedCall) {
      const s = salvage.synthesizedCall;
      truncatedSalvage.push({
        id: s.id,
        type: 'function' as const,
        function: {
          name: s.name,
          arguments: JSON.stringify(s.argsObject),
        },
      });
      truncatedCallIds.add(s.id);
      log.info(
        `turn#${seq}.${turn} salvaged truncated ${s.name} call (path=${s.argsObject.path}, partial=${s.argsObject.content.length} bytes) — continuation hint will fire on the tool result`,
      );
      turnContent = salvage.strippedContent;
      // Clear envelopeTruncated so the post-loop warning path
      // doesn't ALSO fire — we've handled this truncation as a
      // real salvage now.
      envelopeTruncated = null;
    }
  }
  // Bare `invoke NAME {json}` — a weak-model prose shape (wild-caught
  // on gemma4-e2b-q4/MLX) that no earlier layer recognizes: the model
  // never emits Gemma's `<|tool_call>` trigger so the grammar can't
  // engage, and it narrates the call as `invoke write_file {…}` instead.
  // Last-resort salvage, gated on nothing else having fired.
  const bareInvokeRepaired: typeof structuredCalls = [];
  if (
    structuredCalls.length === 0 &&
    repairedCalls.length === 0 &&
    proseRepaired.length === 0 &&
    xmlTagRepaired.length === 0 &&
    claudeInvokeRepaired.length === 0 &&
    glmRepaired.length === 0 &&
    hermesRepaired.length === 0 &&
    shellRepaired.length === 0 &&
    envelopeRepaired.length === 0 &&
    truncatedSalvage.length === 0 &&
    codeBlockRepaired.length === 0 &&
    turnContent.length > 0
  ) {
    const bareSpans = findBareInvokeToolCallSpans(turnContent, knownToolNames);
    for (const [idx, parsed] of bareSpans.entries()) {
      bareInvokeRepaired.push({
        id: `bare-invoke-repair-${seq}-${turn}-${idx}`,
        type: 'function' as const,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments),
        },
      });
    }
    if (bareSpans.length > 0) {
      turnContent = stripBareInvokeToolCallsFromText(turnContent, bareSpans);
    }
  }

  return {
    turnContent,
    proseRepaired,
    xmlTagRepaired,
    claudeInvokeRepaired,
    glmRepaired,
    hermesRepaired,
    shellRepaired,
    envelopeRepaired,
    envelopeTruncated,
    unknownCall,
    truncatedSalvage,
    bareInvokeRepaired,
  };
}
