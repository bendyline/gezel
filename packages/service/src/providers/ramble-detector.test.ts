import { describe, expect, it } from 'vitest';
import { RambleDetector } from './ramble-detector.js';

const PROSE = 'a'.repeat(100);

describe('RambleDetector', () => {
  it('is a no-op when disabled — never aborts even on a long prose dump', () => {
    const d = new RambleDetector({ threshold: 200, enabled: false });
    expect(d.observeContent('x'.repeat(10_000))).toBe(false);
    expect(d.hasAborted).toBe(false);
  });

  it('fires when prose exceeds the threshold with no action signal', () => {
    const d = new RambleDetector({ threshold: 200, enabled: true });
    expect(d.observeContent(PROSE)).toBe(false); // 100 < 200
    expect(d.observeContent(PROSE + PROSE)).toBe(true); // 200 ≥ 200
    expect(d.hasAborted).toBe(true);
  });

  it('returns false on subsequent calls after aborting', () => {
    const d = new RambleDetector({ threshold: 50, enabled: true });
    expect(d.observeContent(PROSE)).toBe(true);
    expect(d.observeContent(PROSE + PROSE)).toBe(false);
  });

  it('resets the counter when a structured tool-call delta is recorded', () => {
    // Pin postActionThreshold to the same value so this test exercises
    // the sliding-window math without the dual-threshold tightening.
    const d = new RambleDetector({ threshold: 200, postActionThreshold: 200, enabled: true });
    // 150 chars of prose — under threshold.
    expect(d.observeContent('a'.repeat(150))).toBe(false);
    // Structured action at char 150 resets the anchor.
    d.recordStructuredAction(150);
    // Another 150 chars of prose — only 150 since the anchor, still under.
    expect(d.observeContent('a'.repeat(300))).toBe(false);
    // Another 100 chars (250 since action) — now over.
    expect(d.observeContent('a'.repeat(400))).toBe(true);
  });

  it('resets when `<tool_call>` markup appears mid-stream (with explicit close)', () => {
    const d = new RambleDetector({ threshold: 100, postActionThreshold: 100, enabled: true });
    // 80 chars of prose, then a CLOSED tool-call marker, then more prose.
    // (Closed so the detector is in post-action mode, not inside-call —
    // inside-call uses the much higher `insideCallThreshold`.)
    const before = 'a'.repeat(80);
    const marker = '<tool_call></tool_call>';
    const middle = before + marker;
    expect(d.observeContent(middle)).toBe(false);
    // 90 more chars after the marker — still under threshold from the
    // marker anchor.
    expect(d.observeContent(middle + 'b'.repeat(90))).toBe(false);
    // 110 chars after the marker — trips.
    expect(d.observeContent(middle + 'b'.repeat(110))).toBe(true);
  });

  it('catches the wild failure mode: one tool call early, then long ramble', () => {
    const d = new RambleDetector({ threshold: 6000, enabled: true });
    // Model emits markup early.
    const earlyMarkup =
      'short opener... <tool_call><function=read_task_notes>...</function></tool_call>';
    expect(d.observeContent(earlyMarkup)).toBe(false);
    // ...then 7000 chars of "Setting up... Writing..." planning prose.
    const ramble = earlyMarkup + 'plan plan plan '.repeat(500);
    expect(ramble.length).toBeGreaterThan(earlyMarkup.length + 6000);
    expect(d.observeContent(ramble)).toBe(true);
  });

  it('resets across multiple tool calls — chained calls never trip', () => {
    const d = new RambleDetector({ threshold: 50, enabled: true });
    let content = '';
    // Three consecutive tool calls, each preceded by 30 chars of glue.
    for (let i = 0; i < 3; i++) {
      content += `${'a'.repeat(30)}<function=foo>`;
      expect(d.observeContent(content)).toBe(false);
    }
    expect(d.hasAborted).toBe(false);
  });

  it('handles markup straddling a chunk boundary via lookback (with explicit close)', () => {
    const d = new RambleDetector({ threshold: 100, postActionThreshold: 100, enabled: true });
    // First chunk ends with the start of the marker.
    expect(d.observeContent(`${'a'.repeat(50)}<tool_`)).toBe(false);
    // Second chunk completes the marker — the lookback window catches it.
    // Use a CLOSED marker so the detector is in post-action mode (the
    // mode this test is exercising). Inside-call mode uses
    // `insideCallThreshold` which is 5x higher.
    const marker = '<tool_call></tool_call>';
    expect(d.observeContent(`${'a'.repeat(50)}${marker}`)).toBe(false);
    // 90 chars of prose after the marker — still under the 100 threshold.
    expect(d.observeContent(`${'a'.repeat(50)}${marker}${'b'.repeat(90)}`)).toBe(false);
    // 110 chars after — trips.
    expect(d.observeContent(`${'a'.repeat(50)}${marker}${'b'.repeat(110)}`)).toBe(true);
  });

  it('exposes proseSinceLastAction for debug logging', () => {
    const d = new RambleDetector({ threshold: 1000, enabled: true });
    d.observeContent(`${'a'.repeat(50)}<function=foo>${'b'.repeat(120)}`);
    // Anchor sits at the position of `<function=`, prose-since is the
    // length of the trailing 'b' run.
    expect(d.proseSinceLastAction).toBeGreaterThan(0);
  });

  describe('post-action tightening', () => {
    it('switches to the tighter threshold once a CLOSED tool-call span appears', () => {
      // Behavior change: the post-action cap now only
      // applies after a tool call has CLOSED. While the model is
      // still emitting content inside an unclosed `<function=…>`
      // (e.g. a large write_file body), the looser cold threshold
      // applies — see the "INSIDE an unclosed <function=…>" test
      // below for the wild-caught Qwen 3.6 27B failure this fixes.
      const d = new RambleDetector({
        threshold: 1000,
        postActionThreshold: 100,
        enabled: true,
      });
      // Cold ramble of 500 chars — under the cold threshold, no abort.
      expect(d.observeContent('a'.repeat(500))).toBe(false);
      expect(d.activeThreshold).toBe(1000);
      // Closed tool-call span arrives — only NOW does post-action mode engage.
      const withClosedCall = `${'a'.repeat(500)}<function=foo></function>`;
      expect(d.observeContent(withClosedCall)).toBe(false);
      expect(d.inPostActionMode).toBe(true);
      expect(d.activeThreshold).toBe(100);
      // 90 chars after the closed call — under the tightened threshold.
      expect(d.observeContent(withClosedCall + 'b'.repeat(90))).toBe(false);
      // 110 chars after — trips on the post-action cap.
      expect(d.observeContent(withClosedCall + 'b'.repeat(110))).toBe(true);
    });

    it('switches to the tighter threshold on a structured tool-call delta', () => {
      const d = new RambleDetector({
        threshold: 1000,
        postActionThreshold: 100,
        enabled: true,
      });
      d.recordStructuredAction(0);
      expect(d.inPostActionMode).toBe(true);
      // 90 chars — under tightened threshold.
      expect(d.observeContent('b'.repeat(90))).toBe(false);
      // 110 chars — trips.
      expect(d.observeContent('b'.repeat(110))).toBe(true);
    });

    it('cold-ramble path still uses the loose threshold when no markup appears', () => {
      const d = new RambleDetector({
        threshold: 1000,
        postActionThreshold: 100,
        enabled: true,
      });
      // 500 chars of cold prose — well over the post-action cap (100)
      // but under the cold cap (1000). Must NOT abort.
      expect(d.observeContent('a'.repeat(500))).toBe(false);
      expect(d.inPostActionMode).toBe(false);
      // 1100 chars of cold prose — over the cold cap.
      expect(d.observeContent('a'.repeat(1100))).toBe(true);
    });

    it('channel markers reset cold prose without entering tool-call body mode', () => {
      const d = new RambleDetector({
        threshold: 1000,
        postActionThreshold: 100,
        enabled: true,
      });
      const opener = `${'a'.repeat(900)}<|channel|>analysis<|message|>`;
      expect(d.observeContent(opener)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(false);
      expect(d.inPostActionMode).toBe(false);
      expect(d.activeThreshold).toBe(1000);
      expect(d.observeContent(opener + 'b'.repeat(900))).toBe(false);
      expect(d.observeContent(opener + 'b'.repeat(1100))).toBe(true);
    });

    it('defaults postActionThreshold to ~25% of threshold when omitted', () => {
      const d = new RambleDetector({ threshold: 4000, enabled: true });
      // No explicit postActionThreshold — should be 1000 (= 4000/4).
      d.recordStructuredAction(0);
      expect(d.activeThreshold).toBe(1000);
    });

    it('post-action default has a floor of 500 chars even for tiny thresholds', () => {
      const d = new RambleDetector({ threshold: 100, enabled: true });
      d.recordStructuredAction(0);
      // 100/4 = 25, but the floor keeps it at 500 so the cap isn't
      // pathologically short.
      expect(d.activeThreshold).toBe(500);
    });

    it('does NOT fire while the model is INSIDE an unclosed <function=…> writing a large parameter body', () => {
      // Wild-caught Qwen 3.6 27B (MLX, tictactoe trials):
      // Tamara emits `<function=write_file>` and then streams 5 KB+ of
      // HTML as the `content` parameter value. The previous code
      // counted the post-`<function=` body as "prose since action" and
      // aborted at the tight post-action cap (default 1500). Now the
      // detector recognizes the opener-without-closer state and falls
      // back to the looser cold threshold for as long as we're inside
      // the tool call.
      const d = new RambleDetector({
        threshold: 8000,
        postActionThreshold: 1500,
        enabled: true,
      });
      const opener =
        '<tool_call>\n<function=write_file>\n<parameter=path>index.html</parameter>\n<parameter=content>\n';
      // 5000 chars of HTML body — way past the 1500 post-action cap,
      // still well under the 8000 cold cap. Must NOT fire while the
      // call is unclosed.
      const body = '<!DOCTYPE html>\n'.repeat(330);
      expect(body.length).toBeGreaterThan(1500);
      expect(body.length).toBeLessThan(8000);
      expect(d.observeContent(opener + body)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(true);
      // insideCallThreshold defaults to max(32_000, 5 × threshold) =
      // max(32_000, 40_000) = 40_000 for this fixture.
      expect(d.activeThreshold).toBe(40000);
    });

    it('flips back to the tight post-action cap once </function> or </tool_call> arrives', () => {
      // After the write_file call closes, follow-up prose is the
      // "planning paralysis" case that the post-action cap is built
      // for — fire fast on that.
      const d = new RambleDetector({
        threshold: 8000,
        postActionThreshold: 1500,
        enabled: true,
      });
      const opener = '<tool_call>\n<function=write_file>\n<parameter=content>';
      const body = 'x'.repeat(3000); // inside call — exempt from post-action cap
      const closer = '</parameter>\n</function>\n</tool_call>';
      expect(d.observeContent(opener + body + closer)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(false);
      expect(d.activeThreshold).toBe(1500); // back to tight cap
      // 1400 chars of post-close prose — under the tight cap.
      expect(d.observeContent(opener + body + closer + 'p'.repeat(1400))).toBe(false);
      // 1600 chars — over the tight cap, fires.
      expect(d.observeContent(opener + body + closer + 'p'.repeat(1600))).toBe(true);
    });

    it('persists insideUnclosedCall across scan windows that contain no markers', () => {
      // Wild-caught regression (qwen3.6 matrix, after the
      // first open/close-span fix): the `<function=write_file>` opener
      // arrived in one chunk, then 1500+ chars of pure HTML body
      // streamed in subsequent chunks. The first version of the fix
      // computed `insideUnclosedCall` from per-window scan locals —
      // so windows with NO markers silently flipped the flag to false
      // and the tight post-action cap fired on the body content.
      //
      // The fix: persist `lastOpenEndAtChars` on `this` so it survives
      // mark-less scan windows.
      const d = new RambleDetector({
        threshold: 8000,
        postActionThreshold: 1500,
        enabled: true,
      });
      // Window 1: the opener arrives.
      const w1 = '<function=write_file>';
      expect(d.observeContent(w1)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(true);
      // Window 2: more arrives, still no closer, no other markers.
      const w2 = `${w1}<parameter=content>${'x'.repeat(800)}`;
      expect(d.observeContent(w2)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(true);
      // insideCallThreshold defaults to max(32_000, 5 × threshold) =
      // max(32_000, 40_000) = 40_000 for this fixture.
      expect(d.activeThreshold).toBe(40000);
      // Window 3: another 1000 chars (still no closer). With the bug
      // present, this would fire the post-action cap at 1502 chars
      // past the opener. With the fix, the cold cap applies and the
      // detector stays calm.
      const w3 = w2 + 'y'.repeat(1000);
      expect(d.observeContent(w3)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(true);
    });

    it('still fires (insideCallThreshold) on a TRULY runaway unclosed body — safety net', () => {
      // If the model never closes the call and keeps streaming
      // forever, `insideCallThreshold` must still bound the damage.
      // Use an explicit small inside-call cap so the test stays fast.
      const d = new RambleDetector({
        threshold: 2000,
        postActionThreshold: 500,
        insideCallThreshold: 2000,
        enabled: true,
      });
      const opener = '<function=write_file>';
      // 2500 chars after the opener — over the inside-call cap (2000),
      // no closer yet. Must fire.
      expect(d.observeContent(opener + 'x'.repeat(2500))).toBe(true);
    });

    it('insideCallThreshold default is max(32_000, 5 × threshold)', () => {
      const small = new RambleDetector({ threshold: 1000, enabled: true });
      expect(small.observeContent('<function=foo>')).toBe(false);
      expect(small.activeThreshold).toBe(32_000);
      const big = new RambleDetector({ threshold: 10_000, enabled: true });
      expect(big.observeContent('<function=foo>')).toBe(false);
      expect(big.activeThreshold).toBe(50_000);
    });

    it('reproduces the wild Qwen failure: tool early, then planning monologue, fires fast', () => {
      // Simulates the actual transcript: model writes a tool-call
      // markup block early, then dumps ~2000 chars of "Setting up...
      // Writing... Now I'm..." planning prose. With the cold-only
      // 6000-char cap, it would burn another ~4000 chars before
      // firing. With post-action tightening (default 1500), it
      // catches the planning paralysis ~4× faster.
      const d = new RambleDetector({ threshold: 6000, enabled: true });
      const earlyMarkup = 'I have full context. <tool_call>{"name":"read_task_notes"}</tool_call>';
      expect(d.observeContent(earlyMarkup)).toBe(false);
      expect(d.inPostActionMode).toBe(true);
      // 1400 chars of planning prose — under the default 1500 post-action cap.
      const ramble1400 = earlyMarkup + 'Setting up the project structure... '.repeat(40);
      expect(ramble1400.length - earlyMarkup.length).toBeGreaterThan(1400);
      expect(ramble1400.length - earlyMarkup.length).toBeLessThan(1500);
      expect(d.observeContent(ramble1400)).toBe(false);
      // 1700 chars of planning prose — over the post-action cap, fires.
      const ramble1700 = earlyMarkup + 'Setting up the project structure... '.repeat(50);
      expect(d.observeContent(ramble1700)).toBe(true);
    });
  });

  describe('reasoning-span awareness (`<think>` / `<reasoning>`)', () => {
    it('reproduces the wild Qwen failure: 6 KB of `<think>` reasoning no longer trips the cold cap', () => {
      // Wild-caught (qwen3.6 a3b consultation): the model
      // opened `<think>`, reasoned ~6 KB drafting the deliverable, and
      // the 6000-char cold cap fired BEFORE it closed `</think>` and
      // emitted the write_file call. With reasoning-span awareness the
      // unclosed `<think>` body gets the loose inside-call budget.
      const d = new RambleDetector({ threshold: 6000, enabled: true });
      const opener = '<think>';
      const reasoning = opener + 'Let me think about the game loop. '.repeat(200);
      expect(reasoning.length - opener.length).toBeGreaterThan(6000);
      expect(d.observeContent(reasoning)).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
      // Reasoning is not a tool call — must NOT enter post-action mode.
      expect(d.inPostActionMode).toBe(false);
      // insideCallThreshold default = max(32_000, 5 × 6000) = 32_000.
      expect(d.activeThreshold).toBe(32_000);
    });

    it('anchors the prose counter at `</think>` so the visible answer is measured fresh', () => {
      const d = new RambleDetector({
        threshold: 1000,
        postActionThreshold: 1000,
        enabled: true,
      });
      // 800 chars of reasoning, then close. Under the cold cap regardless.
      const block = `<think>${'r'.repeat(800)}</think>`;
      expect(d.observeContent(block)).toBe(false);
      expect(d.isInsideReasoning).toBe(false);
      // Back to the cold cap now that reasoning closed.
      expect(d.activeThreshold).toBe(1000);
      // 900 chars of post-reasoning prose — measured from the close, so
      // under the 1000 cap despite the 800 chars of reasoning before it.
      expect(d.observeContent(block + 'a'.repeat(900))).toBe(false);
      // 1100 chars past the close — now trips.
      expect(d.observeContent(block + 'a'.repeat(1100))).toBe(true);
    });

    it('still fires (insideCallThreshold) on a runaway unclosed `<think>` — safety net', () => {
      const d = new RambleDetector({
        threshold: 2000,
        insideCallThreshold: 2000,
        enabled: true,
      });
      // 2500 chars of reasoning, never closed — over the inside-call cap.
      expect(d.observeContent(`<think>${'r'.repeat(2500)}`)).toBe(true);
    });

    it('recognizes the `<reasoning>` variant too', () => {
      const d = new RambleDetector({ threshold: 1000, enabled: true });
      const reasoning = `<reasoning>${'r'.repeat(1500)}`;
      expect(reasoning.length).toBeGreaterThan(1000);
      expect(d.observeContent(reasoning)).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
    });

    it('persists insideReasoning across scan windows with no markers', () => {
      // Same streaming shape as the tool-call body test: `<think>`
      // arrives in one chunk, then the reasoning body streams across
      // many mark-less chunks. The flag must survive those windows.
      const d = new RambleDetector({ threshold: 2000, enabled: true });
      expect(d.observeContent('<think>')).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
      const w2 = `<think>${'r'.repeat(1500)}`;
      expect(d.observeContent(w2)).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
      // 1000 more chars (2500 past opener) — would trip the cold 2000
      // cap if the flag were lost; with it, the 32_000 inside-call cap
      // applies and we stay calm.
      expect(d.observeContent(w2 + 'r'.repeat(1000))).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
    });

    it('catches a marker straddling a chunk boundary via lookback', () => {
      const d = new RambleDetector({ threshold: 1000, enabled: true });
      // First chunk ends mid-marker.
      expect(d.observeContent(`${'a'.repeat(50)}<thi`)).toBe(false);
      // Second chunk completes `<think>` — lookback window catches it.
      const opened = `${'a'.repeat(50)}<think>${'r'.repeat(1500)}`;
      expect(d.observeContent(opened)).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
    });
  });

  describe('fenced-code-block awareness (chat-coding a file)', () => {
    it('reproduces the wild Qwen failure: a 12 KB file chat-coded inside ```html no longer trips the cold cap', () => {
      // Wild-caught (qwen3.6 a3b consultation): the model
      // chat-coded a ~16 KB index.html inside a ```html fence instead of
      // a write_file body; the 12 KB doubled-cold cap guillotined it
      // mid-file before the fence closed. With fence awareness the open
      // fence gets the loose inside-call budget.
      const d = new RambleDetector({ threshold: 6000, enabled: true, leakyReasoning: true });
      const opened = `Here's the file:\n\`\`\`html\n${'<div>x</div>\n'.repeat(1000)}`;
      expect(opened.length).toBeGreaterThan(12000);
      expect(d.observeContent(opened)).toBe(false);
      expect(d.isInsideFencedCode).toBe(true);
      // A fence is not a tool call — must NOT enter post-action mode.
      expect(d.inPostActionMode).toBe(false);
      expect(d.activeThreshold).toBe(32_000);
    });

    it('anchors the prose counter at the closing fence so trailing narration is measured fresh', () => {
      const d = new RambleDetector({ threshold: 1000, postActionThreshold: 1000, enabled: true });
      // 800 chars inside a CLOSED fence — under the cold cap regardless.
      const block = `\`\`\`html\n${'c'.repeat(800)}\n\`\`\``;
      expect(d.observeContent(block)).toBe(false);
      expect(d.isInsideFencedCode).toBe(false);
      expect(d.activeThreshold).toBe(1000);
      // 900 chars after the close — measured from the close, under the cap.
      expect(d.observeContent(`${block}\n${'a'.repeat(900)}`)).toBe(false);
      // 1100 chars past the close — trips.
      expect(d.observeContent(`${block}\n${'a'.repeat(1100)}`)).toBe(true);
    });

    it('still fires (insideCallThreshold) on a runaway UNCLOSED fence — safety net', () => {
      const d = new RambleDetector({ threshold: 2000, insideCallThreshold: 2000, enabled: true });
      // 2500 chars inside an unclosed fence — over the inside-call cap.
      expect(d.observeContent(`\`\`\`html\n${'c'.repeat(2500)}`)).toBe(true);
    });

    it('handles the ~~~ fence variant and an indented fence', () => {
      const d = new RambleDetector({ threshold: 1000, enabled: true });
      const opened = `  ~~~js\n${'x'.repeat(1500)}`;
      expect(opened.length).toBeGreaterThan(1000);
      expect(d.observeContent(opened)).toBe(false);
      expect(d.isInsideFencedCode).toBe(true);
    });

    it('persists insideFencedCode across mark-less scan windows', () => {
      const d = new RambleDetector({ threshold: 2000, enabled: true });
      expect(d.observeContent('```html\n')).toBe(false);
      expect(d.isInsideFencedCode).toBe(true);
      const w2 = `\`\`\`html\n${'c'.repeat(1500)}`;
      expect(d.observeContent(w2)).toBe(false);
      // 1000 more body chars (2500 past opener) — would trip the cold
      // 2000 cap if the flag were lost; with it the 32_000 cap applies.
      expect(d.observeContent(`${w2}${'c'.repeat(1000)}`)).toBe(false);
      expect(d.isInsideFencedCode).toBe(true);
    });

    it('does not double-count a fence marker re-seen in the lookback overlap', () => {
      const d = new RambleDetector({ threshold: 1000, enabled: true });
      // Open a fence, then stream small chunks so the opener sits in the
      // 16-char lookback overlap on the next observe. Parity must stay
      // "inside" (one marker), not flip back to "outside".
      expect(d.observeContent('```html\n')).toBe(false);
      expect(d.observeContent('```html\nabc')).toBe(false);
      expect(d.observeContent('```html\nabcdef')).toBe(false);
      expect(d.isInsideFencedCode).toBe(true);
    });
  });

  describe('leaky-reasoning cold budget (untagged planning)', () => {
    it('doubles ONLY the cold cap for leaky-reasoning models', () => {
      const normal = new RambleDetector({ threshold: 6000, enabled: true });
      expect(normal.activeThreshold).toBe(6000);
      const leaky = new RambleDetector({ threshold: 6000, enabled: true, leakyReasoning: true });
      expect(leaky.activeThreshold).toBe(12000);
    });

    it('lets a leaker narrate ~6.5 KB of untagged plan and still reach the tool call', () => {
      // Wild-caught: a voorman leaked ~6000 chars of "I need to… I will:
      // 1. ensure_gezel a" and aborted one token before the call.
      const normal = new RambleDetector({ threshold: 6000, enabled: true });
      expect(normal.observeContent('a'.repeat(6500))).toBe(true); // normal: aborts
      const leaky = new RambleDetector({ threshold: 6000, enabled: true, leakyReasoning: true });
      expect(leaky.observeContent('a'.repeat(6500))).toBe(false); // leaky: room to act
    });

    it('still aborts a truly-runaway leaker past the doubled cap', () => {
      const leaky = new RambleDetector({ threshold: 6000, enabled: true, leakyReasoning: true });
      expect(leaky.observeContent('a'.repeat(12001))).toBe(true);
    });

    it('does NOT widen the post-action cap (acted models still gated tight)', () => {
      const leaky = new RambleDetector({
        threshold: 6000,
        postActionThreshold: 1500,
        enabled: true,
        leakyReasoning: true,
      });
      leaky.recordStructuredAction(0);
      expect(leaky.activeThreshold).toBe(1500);
    });
  });

  describe('repetition guard (planning loop)', () => {
    // Three near-duplicate planning sentences cycled — lots of distinct
    // words, but the trigrams repeat. This is the qwen3.6 voorman
    // failure shape: it circled the same hypotheses for ~12 KB.
    const LOOP =
      'Let me check the task status with list_tasks and list_dir. ' +
      'I should check list_tasks and list_dir to confirm the file exists. ' +
      'Let me check the task status and then reply to Zephyr that it is done. ';
    const circling = LOOP.repeat(20);

    it('fires on a circling monologue well before the length cap', () => {
      // Cold cap is a generous 20 KB (and doubled to 40 KB if this were
      // leaky) — the length path would let this run for ages. The
      // repetition guard catches it at ~one window instead.
      const d = new RambleDetector({ threshold: 20_000, enabled: true });
      expect(circling.length).toBeGreaterThan(2400);
      expect(circling.length).toBeLessThan(20_000);
      expect(d.observeContent(circling)).toBe(true);
      expect(d.firedOnRepetition).toBe(true);
    });

    it('fires the same way for a leaky-reasoning model (orthogonal to the 2× cap)', () => {
      const leaky = new RambleDetector({
        threshold: 6000,
        enabled: true,
        leakyReasoning: true,
      });
      // 12 KB doubled cold cap would NOT have fired on length here.
      expect(leaky.observeContent(circling)).toBe(true);
      expect(leaky.firedOnRepetition).toBe(true);
    });

    it('does NOT fire on long, genuinely varied prose (high novelty)', () => {
      // 150 distinct sentences — every trigram essentially unique.
      const varied = Array.from(
        { length: 150 },
        (_, i) =>
          `Observation ${i}: metric ${(i * 13) % 97} held during phase ${i % 7} of run ${i}.`,
      ).join(' ');
      const d = new RambleDetector({ threshold: 100_000, enabled: true });
      expect(varied.length).toBeGreaterThan(2400);
      expect(d.observeContent(varied)).toBe(false);
      expect(d.firedOnRepetition).toBe(false);
    });

    it('does NOT fire on a single repeated token (distinct-word floor)', () => {
      // `aaaa…` and `plan plan plan…` have ~zero novelty but are
      // degenerate filler, not planning paralysis — length caps own
      // those. The distinct-word floor (8) keeps the guard off them.
      const d = new RambleDetector({ threshold: 20_000, enabled: true });
      expect(d.observeContent('a'.repeat(5000))).toBe(false);
      expect(d.observeContent('plan '.repeat(1000))).toBe(false);
      expect(d.firedOnRepetition).toBe(false);
    });

    it('is exempt inside an unclosed tool-call body (repetitive code is fine)', () => {
      const d = new RambleDetector({ threshold: 6000, enabled: true });
      const opener = '<function=write_file>\n<parameter=content>\n';
      // A repeated multi-identifier JS line — >8 distinct words, low
      // novelty — but it's the file body, not a planning loop.
      const body =
        'const enemyShip = playerPosition.velocityX + gravityForce.deltaTime * frameScalar.constant;\n'.repeat(
          60,
        );
      expect(body.length).toBeGreaterThan(2400);
      expect(d.observeContent(opener + body)).toBe(false);
      expect(d.isInsideUnclosedCall).toBe(true);
      expect(d.firedOnRepetition).toBe(false);
    });

    it('is exempt inside an unclosed reasoning span (a chain may revisit ideas)', () => {
      const d = new RambleDetector({ threshold: 6000, enabled: true });
      expect(d.observeContent(`<think>${circling}`)).toBe(false);
      expect(d.isInsideReasoning).toBe(true);
      expect(d.firedOnRepetition).toBe(false);
    });

    it('can be disabled with repetitionMinNovelty: 0 (length caps still apply)', () => {
      const d = new RambleDetector({
        threshold: 20_000,
        repetitionMinNovelty: 0,
        enabled: true,
      });
      expect(d.observeContent(circling)).toBe(false);
      expect(d.firedOnRepetition).toBe(false);
    });

    it('stays dormant until the trailing window fills', () => {
      const d = new RambleDetector({ threshold: 20_000, repetitionWindow: 2400, enabled: true });
      // A short circling snippet under the window — not enough sample.
      expect(d.observeContent(LOOP)).toBe(false);
      expect(d.firedOnRepetition).toBe(false);
    });

    describe('repetition-guard-only mode (length caps off)', () => {
      // The ds4 shape: a non-verbose model with the length caps disabled
      // (`enabled: false`) still gets loop protection via the independent
      // `repetitionGuardEnabled` gate.
      it('fires on a circling monologue even with the length caps off', () => {
        const d = new RambleDetector({
          threshold: 6000,
          enabled: false,
          repetitionGuardEnabled: true,
        });
        expect(d.observeContent(circling)).toBe(true);
        expect(d.firedOnRepetition).toBe(true);
      });

      it('does NOT apply length caps in guard-only mode — long varied prose passes', () => {
        const d = new RambleDetector({
          threshold: 200,
          enabled: false,
          repetitionGuardEnabled: true,
        });
        // 10 KB of unique sentences: far past the 200-char cold cap, but
        // the caps are off in guard-only mode and novelty is high, so no
        // abort. This is the whole point — a legitimate long answer on a
        // non-verbose model is not guillotined.
        const varied = Array.from(
          { length: 200 },
          (_, i) => `Point ${i}: value ${(i * 17) % 89} observed in window ${i % 11}.`,
        ).join(' ');
        expect(varied.length).toBeGreaterThan(6000);
        expect(d.observeContent(varied)).toBe(false);
        expect(d.hasAborted).toBe(false);
      });

      it('is still a full no-op when BOTH gates are off', () => {
        const d = new RambleDetector({
          threshold: 200,
          enabled: false,
          repetitionGuardEnabled: false,
        });
        expect(d.observeContent(circling)).toBe(false);
        expect(d.observeContent('x'.repeat(10_000))).toBe(false);
        expect(d.hasAborted).toBe(false);
      });

      it('defaults `repetitionGuardEnabled` to `enabled` (disabled stays fully off)', () => {
        // Back-compat: a detector constructed `enabled: false` with no
        // explicit guard flag remains a no-op, exactly as before.
        const d = new RambleDetector({ threshold: 200, enabled: false });
        expect(d.observeContent(circling)).toBe(false);
        expect(d.hasAborted).toBe(false);
      });
    });
  });
});
