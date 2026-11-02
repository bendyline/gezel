import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crewModel } from '../mapper/crew.js';
import { cleanExcerpt, thoughtExcerpt, toolVerb } from '../mapper/narration.js';
import { recordingToDoc } from '../mapper/recordingToDoc.js';
import { wrapLines } from '../mapper/scenes.js';
import { runNeededHelp } from '../mapper/timing.js';
import { poppetjeMediaPath } from '../media.js';
import { loadRecording } from '../recording.js';

const fixtureRaw: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'transcript.sample.json'), 'utf8'),
);

describe('loadRecording', () => {
  it('accepts the contract fixture', () => {
    const { recording, warnings } = loadRecording(fixtureRaw);
    expect(warnings).toEqual([]);
    expect(recording.scenes).toHaveLength(11);
  });

  it('drops unknown scene kinds with a warning instead of failing playback', () => {
    const raw = structuredClone(fixtureRaw) as { scenes: unknown[] };
    raw.scenes.push({ kind: 'hologram', at: '2026-09-01T10:10:00.000Z' });
    const { recording, warnings } = loadRecording(raw);
    expect(recording.scenes).toHaveLength(11);
    expect(warnings).toHaveLength(1);
  });
});

describe('recordingToDoc', () => {
  const { recording } = loadRecording(fixtureRaw);

  for (const profile of ['debug', 'marketing'] as const) {
    it(`${profile}: produces a monotonic, gap-free, duration-consistent doc`, () => {
      const { doc } = recordingToDoc(recording, profile);
      expect(doc.blocks.length).toBeGreaterThan(2);
      let cursor = 0;
      for (const block of doc.blocks) {
        expect(block.startTime).toBeGreaterThanOrEqual(cursor - 0.01);
        expect(block.duration).toBeGreaterThan(0);
        expect(block.layers?.length ?? 0).toBeGreaterThan(0);
        cursor = block.startTime + block.duration;
      }
      const last = doc.blocks[doc.blocks.length - 1]!;
      expect(doc.duration).toBeCloseTo(last.startTime + last.duration, 1);
      // Synthetic clock: no audio segments; captions narrate every SCENE
      // block — cover, cast card and outro are full-screen text and carry none.
      expect(doc.audio.segments).toHaveLength(0);
      const sceneBlocks = doc.blocks.filter(
        (block) => !['scene-cover', 'scene-cast', 'scene-outro'].includes(block.id),
      );
      expect(doc.captions?.phrases.length).toBe(sceneBlocks.length);
    });
  }

  it('marketing: lands near the target duration and within the block budget', () => {
    const { doc } = recordingToDoc(recording, 'marketing');
    expect(doc.blocks.length).toBeLessThanOrEqual(28);
    // Target is a ceiling: a short fixture plays at its natural pace (well
    // above the per-scene floor), a long one is compressed to ~2.5 min.
    expect(doc.duration).toBeGreaterThanOrEqual(45);
    expect(doc.duration).toBeLessThanOrEqual(160);
    // The money shot always survives selection.
    expect(doc.blocks.some((block) => block.id.endsWith('delegation'))).toBe(true);
  });

  it('debug: shows wall-clock stamps and covers every scene', () => {
    const { doc } = recordingToDoc(recording, 'debug');
    // cover + 11 scenes + outro
    expect(doc.blocks).toHaveLength(13);
    const sceneBlock = doc.blocks[1]!;
    const clock = sceneBlock.layers?.find((layer) => layer.id.endsWith('-clock'));
    expect(clock).toBeDefined();
  });

  it('renders initials avatars without media, poppetje images with it', () => {
    const bare = recordingToDoc(recording, 'debug');
    const bareAvatars = bare.doc.blocks
      .flatMap((block) => block.layers ?? [])
      .filter((layer) => layer.id.includes('avatar'));
    expect(bareAvatars.every((layer) => layer.type !== 'image')).toBe(true);
    expect(bare.media.every((ref) => ref.kind === 'screenshot')).toBe(true);

    const served = recordingToDoc(recording, 'debug', {
      availableMedia: new Set([poppetjeMediaPath('ada'), poppetjeMediaPath('rex')]),
    });
    const imageAvatars = served.doc.blocks
      .flatMap((block) => block.layers ?? [])
      .filter((layer) => layer.id.includes('avatar') && layer.type === 'image');
    expect(imageAvatars.length).toBeGreaterThan(0);
    expect(served.media.some((ref) => ref.kind === 'poppetje')).toBe(true);
  });

  it('screenshot scenes reference the recording-relative file', () => {
    const { doc, media } = recordingToDoc(recording, 'debug');
    const artifactBlock = doc.blocks.find((block) => block.id.endsWith('artifact-produced'));
    const image = artifactBlock?.layers?.find((layer) => layer.type === 'image');
    expect(image && 'content' in image && (image.content as { src: string }).src).toBe(
      'screenshots/00-report.png',
    );
    expect(media).toContainEqual({ path: 'screenshots/00-report.png', kind: 'screenshot' });
  });

  it('credits every speaker with their role and stamps theme fonts on all text', () => {
    const { doc } = recordingToDoc(recording, 'debug');
    const textLayers = doc.blocks.flatMap((block) =>
      (block.layers ?? []).filter((layer) => layer.type === 'text'),
    );
    expect(textLayers.length).toBeGreaterThan(0);
    // No authored text layer may fall back to the platform UI font.
    expect(
      textLayers.every(
        (layer) =>
          typeof (layer as { content: { style: { fontFamily?: string } } }).content.style
            .fontFamily === 'string',
      ),
    ).toBe(true);
    expect(doc.themeId).toBeDefined();
    const nameLabels = textLayers
      .filter((layer) => layer.id.endsWith('-name'))
      .map((layer) => (layer as { content: { text: string } }).content.text);
    expect(nameLabels.some((label) => label.includes('Rex  ·  Reviewer'))).toBe(true);
  });

  it('paces marketing scenes to be readable and leaves harness nudges out of the cut', () => {
    const nudged = structuredClone(recording);
    nudged.scenes.push({
      kind: 'delegation',
      at: '2026-09-01T10:09:50.000Z',
      actorId: 'ada',
      toActorId: 'rex',
      excerpt: '[scenario check] The success criteria are not met yet.',
    });
    const marketing = recordingToDoc(nudged, 'marketing').doc;
    const debug = recordingToDoc(nudged, 'debug').doc;
    const marketingTexts = marketing.blocks.flatMap((block) =>
      (block.layers ?? []).map((layer) =>
        layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
      ),
    );
    expect(marketingTexts.some((text) => text.includes('[scenario check]'))).toBe(false);
    const debugTexts = debug.blocks.flatMap((block) =>
      (block.layers ?? []).map((layer) =>
        layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
      ),
    );
    expect(debugTexts.some((text) => text.includes('[scenario check]'))).toBe(true);
    // Every scene block (cover/outro excluded) dwells at least the floor.
    for (const block of marketing.blocks.slice(1, -1)) {
      expect(block.duration).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps bubble text inside its bubble, even for the longest excerpts', () => {
    const wordy = structuredClone(recording);
    const long = 'Create the slide design system for the deck and read every source. '.repeat(8);
    wordy.scenes.push(
      { kind: 'reply', at: '2026-09-01T10:09:46.000Z', actorId: 'rex', excerpt: long },
      {
        kind: 'delegation',
        at: '2026-09-01T10:09:47.000Z',
        actorId: 'ada',
        toActorId: 'rex',
        excerpt: long,
      },
    );
    for (const profile of ['debug', 'marketing'] as const) {
      const { doc } = recordingToDoc(wordy, profile);
      const pct = (value: string | number | undefined) => Number.parseFloat(String(value ?? '0'));
      let checked = 0;
      for (const block of doc.blocks) {
        const bubble = block.layers?.find((layer) => layer.id.endsWith('-bubble'));
        const lines = (block.layers ?? []).filter((layer) => /-text-\d+$/.test(layer.id));
        if (!bubble || lines.length === 0) continue;
        checked += 1;
        const bubbleTop = pct(bubble.position.y);
        const bubbleBottom = bubbleTop + pct(bubble.position.height);
        // 32px lines at 1.35 line height on the 1080 basis.
        const lineHeight = ((32 * 1.35) / 1080) * 100;
        let lastDelay = -1;
        for (const line of lines) {
          const top = pct(line.position.y);
          expect(top).toBeGreaterThanOrEqual(bubbleTop);
          expect(top + lineHeight).toBeLessThanOrEqual(bubbleBottom + 0.01);
          // Lines flow in top to bottom, one at a time.
          const delay = line.animation?.delay ?? 0;
          expect(line.animation?.type).toBe('fadeInUp');
          expect(delay).toBeGreaterThan(lastDelay);
          lastDelay = delay;
        }
        expect(bubbleBottom).toBeLessThanOrEqual(profile === 'marketing' ? 74 : 100);
      }
      expect(checked).toBeGreaterThan(2);
    }
  });

  it('wraps on word boundaries and marks a cut with an ellipsis', () => {
    const lines = wrapLines('one two three four five six seven eight nine ten', 32, 10, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join(' ').replace('…', '')).toMatch(/^one two/);
    expect(wrapLines('short', 32, 50, 3)).toEqual(['short']);
    expect(wrapLines('a\nb', 32, 50, 3)).toEqual(['a', 'b']);
    const cut = wrapLines('word '.repeat(200), 32, 20, 2);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.endsWith('…')).toBe(true);
  });

  it('is deterministic: identical input, byte-identical doc', () => {
    const a = JSON.stringify(recordingToDoc(recording, 'marketing').doc);
    const b = JSON.stringify(recordingToDoc(recording, 'marketing').doc);
    expect(a).toBe(b);
  });
});

describe('the marketing cut for people, not triage', () => {
  const { recording } = loadRecording(fixtureRaw);
  const texts = (doc: ReturnType<typeof recordingToDoc>['doc']) =>
    doc.blocks.flatMap((block) =>
      (block.layers ?? []).map((layer) =>
        layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
      ),
    );

  it('flags a run that needed the harness or lost a turn', () => {
    expect(runNeededHelp(recording.scenes)).toBe(false);
    const nudged = structuredClone(recording);
    nudged.scenes.push({
      kind: 'user-prompt',
      at: '2026-09-01T10:09:50.000Z',
      actorId: 'user',
      excerpt: '[eval recovery] Your previous turn aborted.',
    });
    expect(runNeededHelp(nudged.scenes)).toBe(true);
  });

  it('cleans excerpts for viewers: no markdown, no hand-off plumbing', () => {
    expect(
      cleanExcerpt(
        'Build the **logo** in `assets/logo.png`.\n\n[Deliverable expected as an IMAGE FILE at `x`]',
      ),
    ).toBe('Build the logo in assets/logo.png.');
    expect(
      cleanExcerpt(
        'Publish step complete. Saved to tasks/eval/report.docx (sha256 feaca44cf7d7463443f75b6353c58cfd544e27107e6648c5e70c33de600ff9c4, 9 KB).',
      ),
    ).toBe('Publish step complete. Saved to tasks/eval/report.docx…');
    expect(toolVerb('suggest_work')).toBe('finds the right plan');
    expect(toolVerb('some_new_tool')).toBe('uses some new tool');
  });

  it('uses the plain title and model name, and ends on the facts it is given', () => {
    const { doc } = recordingToDoc(recording, 'marketing', {
      title: 'Build a pet shop website',
      modelLabel: 'Gemma 4 (12B, Q4)',
      endCard: {
        headline: 'Done in 2 minutes',
        lines: ['Gemma 4 (12B, Q4) on AMD Radeon AI PRO R9700', 'Passed 2 of 3 attempts'],
        screenshotRef: 'screenshots/00-index.png',
      },
    });
    const all = texts(doc);
    expect(all.filter(Boolean)[0]).toBe('Build a pet shop website');
    expect(all.some((text) => text.includes('on Gemma 4 (12B, Q4)'))).toBe(true);
    const outro = doc.blocks[doc.blocks.length - 1]!;
    const outroTexts = (outro.layers ?? []).map((layer) =>
      layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
    );
    expect(outroTexts).toContain('Done in 2 minutes');
    expect(outroTexts.join('\n')).toContain('Passed 2 of 3 attempts');
    expect(outro.layers?.some((layer) => layer.type === 'image')).toBe(true);
    // No eval plumbing on screen in the marketing cut.
    expect(all.some((text) => /GATE: |task [\w-]+\/\d/.test(text))).toBe(false);
  });

  it('keeps the debug cut a faithful record', () => {
    const { doc } = recordingToDoc(recording, 'debug', {
      title: 'Build a pet shop website',
      endCard: { headline: 'ignored', lines: [] },
    });
    expect(texts(doc)).not.toContain('ignored');
  });
});

describe('the crew, the plan and the gezels thinking', () => {
  const { recording } = loadRecording(fixtureRaw);

  it('reads the cast in order of appearance, with who handed whom the work', () => {
    const crew = crewModel(recording);
    expect(crew.members.map((member) => member.id)).toEqual(['user', 'ada', 'rex']);
    expect(crew.members[1]!.fromId).toBe('user');
    expect(crew.members[2]!.fromId).toBe('ada');
    expect(crew.plan.map((step) => [step.stepId, step.ownerId, step.completed])).toEqual([
      ['review', 'rex', true],
    ]);
    expect(crew.members[2]!.steps).toEqual([crew.plan[0]!.name]);
  });

  it('drops a trailing bookkeeping step nobody worked', () => {
    const withFinish = structuredClone(recording);
    withFinish.scenes.push({
      kind: 'step-transition',
      at: '2026-09-01T10:09:59.000Z',
      stepId: 'finish',
      stepName: 'Finish',
      phase: 'activated',
    });
    expect(crewModel(withFinish).plan.map((step) => step.stepId)).toEqual(['review']);
  });

  it('opens the marketing cut on the crew and keeps the same rail on every scene', () => {
    const { doc } = recordingToDoc(recording, 'marketing');
    expect(doc.blocks[1]!.id).toBe('scene-cast');
    const scenes = doc.blocks.slice(2, -1);
    expect(scenes.length).toBeGreaterThan(2);
    for (const block of scenes) {
      const labels = (block.layers ?? [])
        .filter((layer) => /-rail-\d+-label$/.test(layer.id))
        .map((layer) => (layer as { content: { text: string } }).content.text);
      expect(labels).toEqual(['You', 'Ada', 'Rex']);
      const rings = (block.layers ?? []).filter((layer) => /-rail-\d+-ring$/.test(layer.id));
      expect(rings).toHaveLength(3);
    }
    // The delegation lights both ends of the hand-off.
    const handoff = doc.blocks.find((block) => block.id.endsWith('delegation'))!;
    const lit = (handoff.layers ?? []).filter(
      (layer) =>
        /-rail-\d+-label$/.test(layer.id) &&
        (layer as { content: { style: { fontWeight?: string } } }).content.style.fontWeight ===
          'bold',
    );
    expect(lit.map((layer) => (layer as { content: { text: string } }).content.text)).toEqual([
      'Ada',
      'Rex',
    ]);
    // The debug cut stays a plain record: no cast card, no rail.
    const debug = recordingToDoc(recording, 'debug').doc;
    expect(debug.blocks.some((block) => block.id === 'scene-cast')).toBe(false);
    expect(
      debug.blocks.some((block) =>
        (block.layers ?? []).some((layer) => layer.id.includes('-rail-')),
      ),
    ).toBe(false);
  });

  it('numbers a step against the plan and draws the plan under it', () => {
    const planned = structuredClone(recording);
    planned.scenes.splice(4, 0, {
      kind: 'step-transition',
      at: '2026-09-01T10:02:59.000Z',
      actorId: 'ada',
      stepId: 'scope',
      stepName: 'Scope the review',
      phase: 'activated',
    });
    const { doc } = recordingToDoc(planned, 'marketing');
    const stepTexts = doc.blocks
      .filter((block) => block.id.endsWith('step-transition'))
      .flatMap((block) =>
        (block.layers ?? []).map((layer) =>
          layer.type === 'text' ? (layer as { content: { text: string } }).content.text : '',
        ),
      );
    expect(stepTexts.some((text) => /^STEP [12] OF 2$/.test(text))).toBe(true);
    expect(stepTexts).toContain('Scope the review');
  });

  it("keeps the part of a trace where the gezel speaks for itself, in the model's words", () => {
    const trace = [
      'The user wants me to perform the "Lock the slide outline" step of task deck-eval/1.',
      '',
      'I need to follow the procedure and call `write_artifact` first.',
      '',
      "I've got both inputs. Next, I'll design the outline: 6-8 slides. The user specified 6-8, so I'll pick 7. Should I include a Sources slide?",
    ].join('\n');
    const thought = thoughtExcerpt(trace);
    expect(thought).toBe(
      "I've got both inputs. Next, I'll design the outline: 6-8 slides. The user specified 6-8, so I'll pick 7. Should I include a Sources slide?",
    );
    // All instructions and tool names: nothing to show.
    expect(thoughtExcerpt('First action: call read_artifact against tasks/eval/scope.md.')).toBe(
      '',
    );
    // A checklist recited from the procedure is not the gezel thinking.
    expect(
      thoughtExcerpt('1. Read the sources.\n2. Write the outline.\n3. Check the outline.'),
    ).toBe('');
  });

  it('shows a readable thought as a thought bubble in the marketing cut', () => {
    const thinking = structuredClone(recording);
    thinking.scenes.splice(2, 0, {
      kind: 'reasoning',
      at: '2026-09-01T10:01:01.000Z',
      actorId: 'ada',
      excerpt:
        "The payment module carries the risk. I'll hand the deep pass to Rex and keep the style nits myself, so the report lands in one go.",
    });
    const { doc } = recordingToDoc(thinking, 'marketing');
    const block = doc.blocks.find((candidate) => candidate.id.endsWith('reasoning'));
    expect(block).toBeDefined();
    expect(block!.layers?.some((layer) => layer.id.endsWith('-dot-0'))).toBe(true);
  });
});
