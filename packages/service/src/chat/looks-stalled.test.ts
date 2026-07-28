import { describe, expect, it } from 'vitest';
import { buildDeliverableEditNudge, claimsCompletion, looksStalled } from './manager.js';

describe('looksStalled', () => {
  it('catches the Leo "Processing Mockup… (I will now process…)" stall', () => {
    const stall =
      'Found it! I see what happened—the files are nested one level deeper than I expected.\n\n' +
      'I can now see `ui_ux_mockup_spec.md` inside the `artifacts` directory. I am reading it now to understand the design requirements.\n\n' +
      '(*Self-correction: I am attempting to read the file. If the read fails again, I will ask you to confirm the exact path or re-upload it.*)\n\n' +
      '**Processing Mockup…**\n\n' +
      '*(I will now process the content of the mockup to prepare for the development phase.)*';
    expect(looksStalled(stall)).toBe(true);
  });

  it('catches "I will now…" as a final paragraph', () => {
    expect(looksStalled('Got it. I will now read the file.')).toBe(true);
  });

  it('catches "Let me check…"', () => {
    expect(looksStalled('Let me check the artifacts folder…')).toBe(true);
  });

  it('catches a bare gerund opener like "Processing…"', () => {
    expect(looksStalled('Processing the spec...')).toBe(true);
  });

  it('catches "Processing Mockup…" as a heading', () => {
    expect(looksStalled('Some context.\n\n**Processing Mockup…**')).toBe(true);
  });

  it('does NOT flag a real answer that mentions intent earlier', () => {
    const good =
      'I will read the spec, then summarize the key UX flows.\n\n' +
      "Here's the summary:\n\n" +
      '- The home page lists featured products\n' +
      '- The product page has a buy button\n' +
      '- Checkout is single-page';
    expect(looksStalled(good)).toBe(false);
  });

  it('does NOT flag a completion confirmation', () => {
    expect(looksStalled('Processing complete. Saved to artifacts/summary.md.')).toBe(false);
  });

  it('does NOT flag a normal answer', () => {
    expect(looksStalled('The total is $42.50 across three line items.')).toBe(false);
  });

  it('flags an empty response as stalled (model bailed)', () => {
    expect(looksStalled('')).toBe(true);
    expect(looksStalled('   \n  ')).toBe(true);
  });

  it('catches "Working on it…" markers', () => {
    expect(looksStalled('Sure thing! Working on it...')).toBe(true);
  });

  it('catches "I\'m going to…"', () => {
    expect(looksStalled("Got the request. I'm going to draft the spec now.")).toBe(true);
  });

  it('catches "I\'ll let you know" — passive promise without tool call', () => {
    // The exact shape that produced the bug: Meester narrates Leo-is-on-it
    // delegation without actually calling message_gezel / advance_task_step.
    // Previous bug: the word "ready" in "plan ready for us to review"
    // short-circuited the stall check.
    const stall =
      "That sounds like a wonderful project! I've set up a new project for Eliza's Pet Shop.\n\n" +
      "To make sure everything stays organized, I've also brought in Leo, a Voorman, to act as the project foreman.\n\n" +
      "Leo is already on it—he's currently working on the initial project breakdown. I'll let you know as soon as he has a plan ready for us to review!";
    expect(looksStalled(stall)).toBe(true);
  });

  it('catches "I\'ll keep you posted"', () => {
    expect(looksStalled("Kicked off the task. I'll keep you posted.")).toBe(true);
  });

  it('catches "I\'ll report back"', () => {
    expect(looksStalled("Starting the scan now. I'll report back with findings.")).toBe(true);
  });

  it('catches "I\'ll update you"', () => {
    expect(looksStalled("Handed off to the voorman. I'll update you when done.")).toBe(true);
  });

  it('does NOT flag a legitimate first-person completion with "ready"', () => {
    // Dropping "ready" from the bail-out mustn't regress genuine
    // "I've prepared / drafted …" completions that happen to use "ready".
    // These have no intent pattern at the end, so the stall check still
    // returns false.
    expect(looksStalled("I've prepared the first draft. It's ready for your feedback.")).toBe(
      false,
    );
  });

  it('still flags explicit completion markers without "ready"', () => {
    expect(looksStalled('Processing complete. Saved to artifacts/summary.md.')).toBe(false);
    expect(looksStalled("All done — here's the final report.")).toBe(false);
  });

  it('catches "I am on track to complete X" (future-tense infinitive)', () => {
    // Real shape from a voorman that stalled instead of handing off.
    // Previous bug: "to complete" fired the completion bail-out.
    const stall =
      'Rafael, the visual mandate is now clear.\n\n' +
      'The design phase is now fully greenlit to proceed with these specific guardrails. ' +
      'I will continue building out the high-fidelity mockups.\n\n' +
      'I am on track to complete the visual design and will flag the need to advance ' +
      'the task to **Copywriting** next, once the mocks are locked down.';
    expect(looksStalled(stall)).toBe(true);
  });

  it('catches "I will flag the need to advance" passive deferral', () => {
    expect(
      looksStalled("Proceeding with mocks. I'll flag the need to advance to copywriting later."),
    ).toBe(true);
  });

  it('does NOT flag genuine past-tense completion even when using "to complete"', () => {
    // "I've completed" / "Processing complete" must still bail — the fix
    // narrows the infinitive guard, not the general completion pattern.
    expect(looksStalled("I've completed the visual design. Handing off now.")).toBe(false);
  });

  it('catches "I will let you know the moment X is complete" (subordinate completion)', () => {
    // Real voorman stall: the last sentence embeds `complete` in a
    // future clause ("the moment these visual assets are complete")
    // which was firing the completion bail-out and masking the clear
    // `I will let you know` passive promise. Future-intent guard now
    // wins over the embedded completion verb.
    const stall =
      'These assets are the foundational blueprint for the final product. ' +
      'I am iterating on them until I am confident that they are stable and ready to be passed over to Aldric.\n\n' +
      'I will let you know the moment these visual assets are complete and ready for the next phase.';
    expect(looksStalled(stall)).toBe(true);
  });

  it('catches "I\'ll notify you when…" (new passive-promise verb)', () => {
    expect(looksStalled("Working on the mocks. I'll notify you when they're ready.")).toBe(true);
  });

  it('catches "I\'ll alert you"', () => {
    expect(looksStalled("On it. I'll alert you as soon as it ships.")).toBe(true);
  });

  it('catches "I\'ll inform you"', () => {
    expect(looksStalled("Got it. I'll inform you upon completion.")).toBe(true);
  });

  it('catches "I\'ll flag…" (voorman-handoff promise)', () => {
    expect(
      looksStalled("Continuing the mockups. I'll flag the next phase when the design is ready."),
    ).toBe(true);
  });

  it('catches "I\'ll reach out"', () => {
    expect(looksStalled("Drafting now. I'll reach out once the spec is locked.")).toBe(true);
  });

  it('catches "I\'ll touch base"', () => {
    expect(looksStalled("Will start on this. I'll touch base when Aldric is up.")).toBe(true);
  });

  it('does NOT flag a genuine past-tense completion when future-work is mentioned earlier', () => {
    // The future-intent guard only kicks in when the paragraph itself
    // contains a future promise ("I'll / I will + verb"). A clean
    // past-tense completion should still bail — no regression.
    expect(looksStalled("I've finished the report. Full text is in artifacts/summary.md.")).toBe(
      false,
    );
  });

  it('does NOT flag a genuine "X is complete" completion with no future promise', () => {
    expect(looksStalled('The design is complete. Handed to Aldric.')).toBe(false);
  });

  it('catches "But first, let me check…" — discourse marker before intent', () => {
    // Real shape from a Leo voorman session: model writes a polite
    // intro, buries the "let me check" intent past a "But first,"
    // discourse marker, then calls a tool and stops. The raw
    // `^Let me\b` anchor missed it because the sentence didn't START
    // with "Let me". Discourse-marker stripping in the heuristic
    // catches the buried intent.
    const stall =
      "I'd love to help build this Atari-style combat game! " +
      "But first, let me check what's already in the workspace " +
      "and understand the scope of work we're looking at.";
    expect(looksStalled(stall)).toBe(true);
  });

  it('catches "Okay, I will read it now" — filler-prefixed intent', () => {
    expect(looksStalled('Got the brief. Okay, I will read the spec now.')).toBe(true);
  });

  it('catches "Sure, let me look that up" — agreement-prefixed intent', () => {
    expect(looksStalled('Sure, let me look that up for you.')).toBe(true);
  });

  it('does NOT regress legitimate replies that happen to start with "But"', () => {
    // The discourse stripper must not eat real content. "But the answer
    // is X" should pass through and not flag.
    expect(looksStalled('But the answer is 42, based on the linked report.')).toBe(false);
  });

  it("catches the wild-caught Gemma 'I've retrieved X to understand Y' context-gathering stall", () => {
    // Gemma 4 26B in a fresh Ada session: 3 read tools fired, then the
    // closing turn produced just a past-tense summary "I've retrieved
    // the task details and notes for the 'Build Ikari Warriors-style
    // run-and-gun prototype' task to understand exactly where we left
    // off." The actual work (writing files) never started. Past tense
    // + explicit purpose clause is the signature.
    expect(
      looksStalled(
        "I've retrieved the task details and notes for the run-and-gun task to understand exactly where we left off.",
      ),
    ).toBe(true);
    // Variants of the same shape — different verbs, different purposes.
    expect(looksStalled("I've read the design doc to figure out the next step.")).toBe(true);
    expect(looksStalled("I've reviewed the package.json to see what scripts exist.")).toBe(true);
    expect(looksStalled("I've checked the workspace to find out what's already there.")).toBe(true);
  });

  it("does NOT flag past-tense narration that's actually a delivery", () => {
    // "Here's what I found" / "results: ..." should bail via the
    // completion-delivery branch, NOT trip the new context-gather
    // pattern even though "I've reviewed" and "to see" appear inline.
    expect(
      looksStalled(
        "I've reviewed the design doc to see the constraints. Here's the summary: 1) HTML5 canvas, 2) 60fps, 3) keyboard controls.",
      ),
    ).toBe(false);
  });

  it('catches "I have completed X. The next step is to start drafting Y." (planning-stall)', () => {
    // Wild-caught Gemma 4 E4B pattern from the petshop eval. Bautista
    // declares the planning phase done and announces the next
    // implementation action without taking it. Without the
    // pendingNextStep guard, completionTail matched "completed" and
    // the bail-out fired — looksStalled returned false despite the
    // model having more work to do, leaving the user stuck.
    const stall =
      'I have completed the concrete layout specification for the site in `layout_specification.md`. ' +
      'With the design direction and layout defined, the next logical step is to start drafting ' +
      'the core HTML/CSS structure, beginning with the header and hero section.';
    expect(looksStalled(stall)).toBe(true);
  });

  it('catches "...is complete...next, I\'ll write..." impersonal-then-personal next-step', () => {
    expect(
      looksStalled(
        'The design phase is complete. Next, I will write the index.html with the agreed layout.',
      ),
    ).toBe(true);
  });

  it('does NOT flag a genuine handoff like "next step is for you to review"', () => {
    // Bail-out should still fire when the next step is the user's, not
    // the model's. The pendingNextStep guard is gated to *implementation*
    // verbs (write/create/build/...) so user-review handoffs pass.
    expect(
      looksStalled(
        "I've completed the draft. The next step is for you to review the spec and let me know.",
      ),
    ).toBe(false);
  });

  it('catches the wild-caught Gemma 4 E4B "I have identified the need to implement X" diagnosis-without-action stall', () => {
    // squisq Geohash bug: the dev read Geohash.ts across two turns, then
    // closed the turn announcing the fix it had diagnosed but never made
    // the edit. No done/complete verb, no here's/results delivery, and
    // the spelled-out "I have" dodged the `I've + read-verb + to
    // understand` pattern — so looksStalled returned false and the user
    // had to type "keep going" by hand instead of the runtime firing a
    // CONTINUATION_NUDGE automatically.
    expect(
      looksStalled(
        'I have identified the need to implement great-circle path sampling instead of linear interpolation in `getGeohashPath`.',
      ),
    ).toBe(true);
  });

  it('catches the contraction + other diagnosis verbs in the same family', () => {
    expect(looksStalled("I've determined we need to rewrite the parser.")).toBe(true);
    expect(looksStalled('I have concluded that we must refactor the module.')).toBe(true);
    expect(looksStalled("I've pinpointed the bug and need to replace the loop condition.")).toBe(
      true,
    );
  });

  it('catches the impersonal "The fix is to …" remedy-without-action shape', () => {
    expect(
      looksStalled('The fix is to replace linear interpolation with a great-circle formula.'),
    ).toBe(true);
    expect(looksStalled('The root cause is clear. The solution is to rewrite the sampler.')).toBe(
      true,
    );
  });

  it('does NOT flag a genuine diagnosis that was actually applied this turn', () => {
    // Real delivery: a conclusion verb with no "need to/must <impl-verb>"
    // trailing clause. Must stay false so a dev who actually edited the
    // file this turn doesn't get a spurious continuation nudge.
    expect(looksStalled("I've identified the off-by-one and fixed it in index.html.")).toBe(false);
    expect(
      looksStalled("I've determined the root cause and applied the patch to Geohash.ts."),
    ).toBe(false);
  });
});

describe('claimsCompletion', () => {
  it('flags the Claude-style "All done. Here\'s a summary…" finish', () => {
    expect(
      claimsCompletion(
        "All done. Here's a summary of what was shipped:\n\n- Replaced flat LERP with spherical SLERP.",
      ),
    ).toBe(true);
  });

  it('flags a terse false-"done" edit claim', () => {
    expect(claimsCompletion('Fixed the linear interpolation in getGeohashPath.')).toBe(true);
    expect(claimsCompletion('The bug is resolved and the great-circle path is implemented.')).toBe(
      true,
    );
  });

  it('does NOT flag a genuine partial-progress update', () => {
    expect(
      claimsCompletion(
        'I found the bug: the linear interpolation is on line 42 of getGeohashPath.',
      ),
    ).toBe(false);
  });

  it('does NOT flag a question back to the user', () => {
    expect(
      claimsCompletion('Should I replace the LERP with SLERP, or is there a precision constraint?'),
    ).toBe(false);
  });

  it('does NOT flag a subordinate-clause future completion', () => {
    expect(claimsCompletion("I'll let you know once the refactor is complete.")).toBe(false);
  });

  it('is empty-safe', () => {
    expect(claimsCompletion('')).toBe(false);
    expect(claimsCompletion('   \n ')).toBe(false);
  });
});

describe('buildDeliverableEditNudge', () => {
  it('names the exact deliverable file and demands an edit', () => {
    const nudge = buildDeliverableEditNudge('packages/core/src/spatial/Geohash.ts');
    expect(nudge).toContain('packages/core/src/spatial/Geohash.ts');
    expect(nudge).toContain('replace_in_file');
    expect(nudge).toContain('write_file');
    expect(nudge).toContain('not actually done');
  });
});
