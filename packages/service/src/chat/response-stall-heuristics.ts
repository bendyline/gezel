/**
 * Heuristic: did the model end its turn announcing what it would do
 * instead of doing it? Looks at the last paragraph of the response and
 * matches first-person intent phrases ("I will now…", "Let me…"),
 * standalone gerund openers ("Processing…", "Reading the file…"), and
 * generic "thinking out loud" markers. Bails out when the same paragraph
 * also signals completion ("here's the result", "done", "complete") so
 * a model that says "I've finished processing — done." doesn't get
 * mis-flagged.
 *
 * False positives waste one extra continuation nudge (cheap). False
 * negatives mean the user has to manually nudge the model.
 */
export function looksStalled(text: string): boolean {
  return looksStalledImpl(text);
}

/**
 * Confirmation-only prompts are intentionally inert. A reply like
 * "Got it, I'll stay out of the way" looks like first-person future
 * intent to `looksStalled`, but it is exactly the requested outcome
 * when the user said no action is needed.
 */
export function isNoopConfirmationResponse(prompt: string, response: string): boolean {
  const promptText = prompt.toLowerCase();
  const asksForNoAction =
    /\byou\s+(?:do\s+not|don't|don['’]t)\s+need\s+to\s+do\s+anything\b/i.test(promptText) ||
    /\bno\s+action\s+(?:is\s+)?(?:needed|required)\b/i.test(promptText) ||
    /\bnothing\s+(?:for\s+you\s+)?to\s+do\b/i.test(promptText);
  if (!asksForNoAction) return false;

  const asksForConfirmation =
    /\b(?:just\s+)?confirm\b[\s\S]{0,160}\b(?:seen|read|received|noted|acknowledged)\b/i.test(
      prompt,
    ) || /\backnowledge\b[\s\S]{0,80}\b(?:seen|read|received|noted)\b/i.test(prompt);
  if (!asksForConfirmation) return false;

  const normalized = response
    .trim()
    .replace(/^[#>*_`(\s]+/, '')
    .replace(/[)*_`\s]+$/, '')
    .replace(/\s+/g, ' ');
  if (normalized.length === 0 || normalized.length > 800) return false;

  const acknowledgement =
    /^(?:got it|noted|seen|understood|acknowledged|okay|ok|sure|received)\b/i.test(normalized) ||
    /\bI(?:['’]ve|\s+have)\s+(?:seen|read|received|noted|acknowledged)\b/i.test(normalized);
  if (!acknowledgement) return false;

  const workIntent =
    /\b(?:let me|I(?:['’]ll|\s+will|\s+am\s+going\s+to|\s+am\s+now|\s+need\s+to)|I['’]m\s+(?:going\s+to|now)|next,?\s+I|now,?\s+I)\s+(?:read|write|create|build|implement|run|check|fix|start|continue|work|look|open|edit|generate|produce|draft|test|optimise|optimize|debug|review|finish|complete)\b/i;
  return !workIntent.test(normalized);
}

/**
 * Does the reply CLAIM the work is finished? The inverse signal to
 * {@link looksStalled} — used by the false-"done" edit-gate re-prompt to
 * tell a confident "All done. Here's a summary…" (which `looksStalled`
 * deliberately treats as a clean finish and bails on) apart from a
 * genuine partial-progress update or a question. Deliberately narrow:
 * delivery markers anywhere, plus completion/shipped/fixed verbs in the
 * final block, excluding the subordinate-clause futures ("when complete")
 * that `looksStalled` already guards against.
 */
export function claimsCompletion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const blocks = trimmed.split(/\n\s*\n+/);
  const lastBlock = (blocks[blocks.length - 1] ?? '').toLowerCase();
  const whole = trimmed.toLowerCase();
  // Delivery markers ("here's the summary", "all done") are unambiguous
  // finish signals and win outright.
  const delivery = /\b(?:here['’]s|here it is|results?:|summary:|all set|all done)\b/;
  if (delivery.test(whole)) return true;
  // A first-person future promise ("I'll let you know once X is complete")
  // subordinates any completion verb inside it — it's a promise, not a
  // claim. The token-level lookbehind below can't reach across the clause,
  // so this paragraph-level guard wins (mirrors looksStalled's).
  const futurePromise =
    /\b(?:I['’]ll|I\s+will|I\s+am\s+going\s+to|I\s+am\s+about\s+to|I\s+intend\s+to|I\s+plan\s+to)\s+\w+/i;
  if (futurePromise.test(whole)) return false;
  const completion =
    /(?<!\b(?:when|until|once|as|after|if|before|while|to)\s)\b(?:complete|completed|finished|shipped|fixed|implemented|resolved)\b/;
  return completion.test(lastBlock);
}

function looksStalledImpl(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Take the last paragraph (after the final blank line).
  const blocks = trimmed.split(/\n\s*\n+/);
  const lastBlockRaw = blocks[blocks.length - 1]!.trim();

  // Strip surrounding markdown decoration so the patterns can match the
  // bare text. Iterate because parens/italics can stack ("(*I will…*)").
  const stripDecoration = (s: string): string => {
    let out = s;
    for (let i = 0; i < 5; i++) {
      const before = out;
      out = out.replace(/^[#>*_`(\s]+/, '').replace(/[)*_`\s]+$/, '');
      if (out === before) break;
    }
    return out.trim();
  };

  const stripped = stripDecoration(lastBlockRaw);
  if (stripped.length === 0) return true;

  // Bail out when the paragraph signals actual completion — the model is
  // finished, not stalled. Two distinct shapes:
  //
  //   1. `completionTail` — completion verbs NOT preceded by a
  //      subordinating conjunction or an infinitive "to". "All done" /
  //      "Processing complete" bails; "I'll update you when done" /
  //      "as soon as finished" / "on track to complete" does NOT
  //      (those are futures, not actual completion).
  //
  //   2. `completionDelivery` — explicit "here's the X" / "results:" /
  //      "summary:" handoff markers.
  //
  // Deliberately omits a bare `ready` — "plan ready for review" was
  // masking real stalls where the model narrated delegation without
  // calling the tool. Deliberately excludes "to" before the verb —
  // "on track to complete" / "need to finish" are intent, not done.
  const completionTail =
    /(?<!\b(?:when|until|once|as|after|if|before|while|to)\s+)\b(?:complete|completed|done|finished)\b/i;
  const completionDelivery = /\b(?:here['’]s|here it is|results?:|summary:)\b/i;
  // Future-intent guard: when the paragraph contains a first-person
  // future promise ("I'll let you know", "I will notify you"), the
  // completion verb is almost always subordinated inside a future
  // clause ("the moment X is complete", "as soon as it's finished").
  // The lexical lookbehind in `completionTail` can't reach past the
  // immediately-preceding token, so this paragraph-level signal wins.
  // False-positive cost: a rare "I'll clean up. Processing complete."
  // becomes one wasted continuation; that's cheap.
  const futurePromise =
    /\b(?:I['’]ll|I\s+will|I\s+am\s+going\s+to|I\s+am\s+about\s+to|I\s+intend\s+to|I\s+plan\s+to)\s+\w+/i;
  // "I have completed X. The next [logical] step is to start drafting Y."
  // — wild-caught Gemma 4 E4B pattern on the petshop eval. Bautista
  // declares one phase done and announces the next action without
  // taking it. completionTail matches "completed" so the bail-out
  // would fire if we relied only on it; the model's text doesn't
  // contain a first-person future promise that futurePromise would
  // catch either ("the next step is to start drafting" is impersonal).
  // Scoped to *implementation* verbs (write/create/build/draft/...) so
  // a genuine handoff like "the next step is for you to review" still
  // bails out as a real completion. Also fires standalone — a turn
  // that consists of just "Next, I'll write index.html" is itself
  // stalled regardless of whether a completion verb appears.
  const pendingNextStep =
    /\b(?:the\s+next\s+(?:logical\s+|natural\s+|obvious\s+|clear\s+|immediate\s+|key\s+|critical\s+|necessary\s+|actionable\s+|important\s+|right\s+)?(?:step|phase|move|action|task)\s+is\s+(?:to\s+|going\s+to\s+)?(?:start\s+|begin\s+|now\s+)?(?:write|create|build|implement|generate|render|draft|drafting|produce|design|develop|code|add|edit|finalize|wrap|put|commence|kick\s*off|move\s+(?:on\s+)?to)|next(?:,|:)?\s+I(?:['’]ll|\s+will|\s+need\s+to|\s+should|\s+must|\s+have\s+to|\s+am\s+going\s+to)\s+(?:start\s+|begin\s+|now\s+)?(?:write|create|build|implement|generate|render|draft|produce|design|develop|code|add|edit|finalize|wrap|put))/i;
  if (pendingNextStep.test(stripped)) return true;
  if (
    (completionTail.test(stripped) || completionDelivery.test(stripped)) &&
    !futurePromise.test(stripped)
  ) {
    return false;
  }

  // Test the last block AND its final sentence — models often write a
  // useful intro then end with intent ("Got it. I will now read the file.").
  const sentences = stripped
    .split(/(?<=[.!?…])\s+/)
    .map((s) => stripDecoration(s))
    .filter((s) => s.length > 0);
  const lastSentence = sentences[sentences.length - 1] ?? stripped;

  // Discourse-marker stripper: small models often write a verbose lead-in
  // ("But first, let me check…", "Okay, I'll read it now") that buries the
  // intent phrase past the `^`-anchored patterns below. Strip a narrow set
  // of conjunction/filler openers so the match anchors land on the real
  // verb. Iterate because they stack ("Okay, so first, let me check").
  // Kept narrow on purpose — broader stripping risks eating real content.
  const stripLeadingMarkers = (s: string): string => {
    const markerHead =
      /^(?:But (?:first|now|then),?|First (?:of all|things first),?|First,?|Okay,?|OK,?|Alright,?|So,?|Then,?|Well,?|Right,?|Sure,?|Got it,?|Of course,?)\s+/i;
    let out = s;
    for (let i = 0; i < 5; i++) {
      const before = out;
      out = out.replace(markerHead, '');
      if (out === before) break;
    }
    return out;
  };
  const lastSentenceCore = stripLeadingMarkers(lastSentence);

  // Patterns matched from the start of either the whole last paragraph or
  // its final sentence. False positives waste one continuation; false
  // negatives leave the user hanging.
  const patterns: RegExp[] = [
    // First-person intent followed by a verb.
    /^(?:I (?:will|am going to|am about to|am attempting to|am now|need to|am)\s+\w+|I'll\s+\w+|I'm (?:now |about to |going to |attempting to )\w+|Let me\s+(?!know\b)\w+|Now,?\s+I\b|Next,?\s+I\b)/i,
    // Bare gerund opener — often a heading the model wrote in place of
    // doing the work ("Processing Mockup…", "Reading the spec…").
    /^(?:Processing|Reading|Checking|Searching|Loading|Analyzing|Computing|Generating|Drafting|Writing|Preparing|Reviewing|Examining|Looking)\b/i,
    // Standalone "thinking out loud" markers.
    /^(?:One moment|Hold on|Working on (?:it|that)|On it|Stand by)\b/i,
    // Passive "I'll report back" promises — classic shape of a model that
    // narrated delegation to another agent/tool without actually firing
    // the call. The real failure is upstream (the tool wasn't invoked),
    // but detecting the shape here triggers a nudge that usually recovers.
    // Matches anywhere in the last sentence, not just at its head, because
    // these are typically tacked on after an unrelated clause ("Leo's on
    // it now — I'll let you know when he's ready"). Future-tense only:
    // `I've let you know` (past) is a genuine completion, not a stall.
    // Verb list covers every "I'll <passively promise you something>"
    // shape small voormen keep emitting instead of calling a tool.
    /\bI'll\s+(?:let you know|keep you (?:posted|updated|informed)|update you|notify (?:you|us)|alert (?:you|us)|inform (?:you|us)|ping you|report back|circle back|follow up|reach out|touch base|flag\b)/i,
    // "I've (read|retrieved|checked|reviewed|loaded) X to (understand|see
    // |figure out|learn|find out) Y." — wild-caught Gemma 4 26B pattern:
    // the model ran a few read tools, then closed the turn with a past-
    // tense summary of what it now knows ("I've retrieved the task
    // details ... to understand exactly where we left off"). It's
    // grammatically a completion but functionally a stall — the actual
    // work (writing the file, advancing the phase) never happened. The
    // CONTINUATION_NUDGE fired by this match prompts the model to take
    // the next concrete action. Past-tense gating + an explicit purpose
    // clause is what distinguishes this from a real completion ("I've
    // retrieved the data; here's the result.") which already bails out
    // via `completionDelivery`.
    /\bI['’]ve\s+(?:read|retrieved|reviewed|loaded|fetched|checked|examined|inspected|gathered|gotten|got|pulled|looked at|listed)\s+[\s\S]{0,200}?\bto\s+(?:understand|see|figure out|learn|find out|determine|know|grasp|get a sense of|get a feel for|familiarize myself with|orient myself)\b/i,
    // "I have identified the need to implement X" / "I've determined we
    // need to rewrite Y" — first-person DIAGNOSIS that names the change
    // but ends the turn before making it. Wild-caught Gemma 4 E4B on the
    // squisq Geohash bug: the dev read the file across two turns, then
    // closed with "I have identified the need to implement great-circle
    // path sampling instead of linear interpolation in `getGeohashPath`"
    // and stopped — no edit followed. None of the bail-outs caught it:
    // no done/complete verb (completionTail), no here's/results
    // (completionDelivery), the read-verb context-gather pattern above
    // keys on a read verb + "to understand" (here it's "identified" +
    // "need to implement"), and the spelled-out "I have" isn't the
    // `I've` contraction those patterns match. Gate the trailing clause
    // to a modal (need to / have to / must / should) + an
    // implementation/change verb so a genuine delivery ("I've identified
    // and fixed it in index.html" — no modal + verb) does NOT trip, and
    // a real completion still bails via completionTail/-Delivery first
    // (both are checked before this patterns loop runs).
    /\bI(?:['’]ve|\s+have)\s+(?:identified|determined|concluded|realiz\w+|realis\w+|figured\s+out|pinpointed|diagnosed)\b[\s\S]{0,160}?\b(?:needs?\s+to|have\s+to|must|should)\s+(?:implement|replace|change|fix|add|rewrite|refactor|update|modify|introduce|apply|write|create|build|switch|use)\b/i,
    // Impersonal sibling: "The fix is to replace …", "The solution is to
    // rewrite …" — the same diagnosis-without-action shape with the
    // subject dropped. Distinct from `pendingNextStep` (keyed on "the
    // next step is to …"); this keys on the problem/remedy noun.
    /\bthe\s+(?:fix|solution|remedy|correction|change|approach|root\s+cause|issue|problem|bug)\s+is\s+(?:to\s+|going\s+to\s+)?(?:implement|replace|change|fix|add|rewrite|refactor|update|modify|introduce|apply|write|create|build|switch|use)\b/i,
  ];

  for (const pat of patterns) {
    if (pat.test(stripped)) return true;
    if (pat.test(lastSentence)) return true;
    // Re-run the anchored patterns against the discourse-marker-stripped
    // sentence: catches "But first, let me check…" / "Okay, I'll read it"
    // shapes the raw `^`-anchor would miss. Unanchored patterns (#4) get
    // tested redundantly but cheaply.
    if (lastSentenceCore !== lastSentence && pat.test(lastSentenceCore)) return true;
  }

  return false;
}
