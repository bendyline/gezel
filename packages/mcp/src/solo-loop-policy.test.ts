import { describe, expect, it } from 'vitest';
import { craftbookPinFloor, policyForDeliverable, retargetGateLayers } from './solo-loop-policy.js';

const sniff = (deliverable: string, brief: string) =>
  policyForDeliverable(deliverable, brief).sniff;

describe('policyForDeliverable', () => {
  it('routes arcade/action-game briefs to the stricter html-game gate', () => {
    for (const brief of [
      'Build a polished multi-screen arcade game (title → gameplay → game-over → restart)',
      'a top-down tank combat game in one HTML file',
      'space invaders clone',
      'a side-scrolling platformer',
      'an asteroids-style shooter',
      'endless runner with obstacles',
      'a breakout / brick-breaker game',
    ]) {
      expect(sniff('index.html', brief)).toBe('html-game');
    }
  });

  it('keeps DOM board/turn games on html-complete (they would fail html-game by design)', () => {
    for (const brief of [
      'ship a working tic-tac-toe HTML game',
      'a chess board you can play against a friend',
      'a sudoku puzzle grid',
      'a simple to-do list app',
      'a landing page for a coffee shop',
      'a quiz game with multiple choice questions', // "game" but not arcade — DOM is fine
    ]) {
      expect(sniff('index.html', brief)).toBe('html-complete');
    }
  });

  it('uses the nonempty floor for non-HTML deliverables regardless of brief wording', () => {
    // Even an "arcade" word must not promote a .md/.ts deliverable to html-game.
    expect(sniff('review.md', 'review the arcade game repo')).toBe('nonempty');
    expect(sniff('types.ts', 'refactor the shooter engine types')).toBe('nonempty');
    expect(sniff('postmortem.md', 'incident on the tank-combat service')).toBe('nonempty');
  });

  it('reports isArcade only for HTML arcade briefs', () => {
    expect(policyForDeliverable('index.html', 'space shooter').isArcade).toBe(true);
    expect(policyForDeliverable('index.html', 'tic-tac-toe').isArcade).toBe(false);
    expect(policyForDeliverable('game.md', 'space shooter design doc').isArcade).toBe(false);
  });

  it('flags isMultiScreen only for arcade briefs that ask for title/game-over/restart', () => {
    expect(
      policyForDeliverable(
        'index.html',
        'a polished multi-screen arcade game: title screen, gameplay, game-over with restart',
      ).isMultiScreen,
    ).toBe(true);
    // arcade but single-screen (no multi-screen language) — stays html-game, no extra gate.
    expect(policyForDeliverable('index.html', 'a top-down tank combat shooter').isMultiScreen).toBe(
      false,
    );
    // board game never gets the multi-screen requirement even if it says "restart".
    expect(
      policyForDeliverable('index.html', 'tic-tac-toe with a restart button').isMultiScreen,
    ).toBe(false);
  });
});

describe('craftbookPinFloor', () => {
  it('uses the strict 0.3 floor when the match was scored with embeddings', () => {
    expect(craftbookPinFloor(0.675)).toBe(0.3);
    expect(craftbookPinFloor(0)).toBe(0.3);
  });

  it('drops to the calibrated 0.07 lexical floor when embeddings are unavailable', () => {
    // Lexical-only mode: the top suggestion carries no `semantic` component.
    // 0.07 calibrated against REAL macro briefs: the live
    // tic-tac-toe brief's correct pick scores 0.0999 (about-prose dilutes
    // token overlap); the old 0.15 rejected every observed build brief.
    expect(craftbookPinFloor(undefined)).toBe(0.07);
  });

  it('pins a real lexical-only match that the old flat 0.3 floor silently dropped', () => {
    // Regression for the arcade-deluxe 0/3: with embeddings off,
    // even a perfect arcade match scores ~0.18 (lexical only) — above the 0.15
    // lexical floor but below the 0.3 blended floor that used to gate the pin.
    const lexicalOnlyArcadeScore = 0.181;
    expect(lexicalOnlyArcadeScore).toBeGreaterThanOrEqual(craftbookPinFloor(undefined));
    expect(lexicalOnlyArcadeScore).toBeLessThan(craftbookPinFloor(0.5));
  });
});

describe('policyForDeliverable — data deliverables', () => {
  it('routes csv/tsv/json/ndjson to the data-table sniff', () => {
    for (const path of ['out/customers.json', 'data/output.csv', 'rows.tsv', 'feed.ndjson']) {
      const p = policyForDeliverable(path, 'normalize the customer exports');
      expect(p.isData).toBe(true);
      expect(p.isHtml).toBe(false);
      expect(p.sniff).toBe('data-table');
    }
  });

  it('leaves code/doc/image deliverables on the nonempty floor and html unchanged', () => {
    expect(policyForDeliverable('src/types.ts', 'event pipeline').sniff).toBe('nonempty');
    expect(policyForDeliverable('review.md', 'review the repo').sniff).toBe('nonempty');
    expect(policyForDeliverable('assets/logo.png', 'make a logo').sniff).toBe('nonempty');
    expect(policyForDeliverable('index.html', 'pet shop website').sniff).toBe('html-complete');
    expect(policyForDeliverable('index.html', 'tank arcade shooter').sniff).toBe('html-game');
  });

  it('classifies only formats supported by generate_image as raster deliverables', () => {
    for (const path of ['sunset.png', 'assets/photo.jpg', 'art/poster.JPEG', 'hero.webp']) {
      const policy = policyForDeliverable(path, 'produce the requested visual');
      expect(policy.isRasterImage).toBe(true);
      expect(policy.suggestedProducerRole).toBe('image-generator');
    }
    for (const path of ['icon.svg', 'animation.gif', 'index.html', 'image-notes.md']) {
      const policy = policyForDeliverable(path, 'produce a PNG image');
      expect(policy.isRasterImage).toBe(false);
      expect(policy.suggestedProducerRole).toBeUndefined();
    }
  });
});

describe('retargetGateLayers', () => {
  // The bundled build-loop gate shape: html floor + inline-JS parse +
  // the checkHtmlComplete script.
  const bookGate = {
    checks: [
      { kind: 'minBytes', file: 'index.html', bytes: 2048 },
      { kind: 'jsParses', file: 'index.html' },
    ],
    scripts: [{ name: 'checkHtmlComplete', scope: 'standard', inputs: { file: 'index.html' } }],
  };

  it('html: retargets checks + script file inputs, keeps all layers', () => {
    const policy = policyForDeliverable('game.html', 'tic-tac-toe');
    const layers = retargetGateLayers(policy, 'game.html', bookGate);
    expect(layers.checks.find((c) => c.kind === 'minBytes')?.file).toBe('game.html');
    expect(layers.checks.some((c) => c.kind === 'jsParses')).toBe(true);
    expect(layers.scripts?.[0]?.inputs?.file).toBe('game.html');
  });

  it('data: replaces the floor with minBytes 120 + data-table and drops the html script layer', () => {
    const policy = policyForDeliverable('out/customers.json', 'normalize customer data');
    const layers = retargetGateLayers(policy, 'out/customers.json', bookGate);
    expect(layers.checks).toEqual([
      { kind: 'minBytes', file: 'out/customers.json', bytes: 120 },
      { kind: 'sniff', file: 'out/customers.json', sniff: 'data-table' },
    ]);
    // checkHtmlComplete rejects anything without </body> — a retargeted
    // data gate could never pass it (the previously-unwinnable layer).
    expect(layers.scripts).toBeUndefined();
  });

  it('other non-html: drops jsParses + scripts, retargets the byte floor', () => {
    const policy = policyForDeliverable('review.md', 'review the repo');
    const layers = retargetGateLayers(policy, 'review.md', bookGate);
    expect(layers.checks.some((c) => c.kind === 'jsParses')).toBe(false);
    expect(layers.checks.find((c) => c.kind === 'minBytes')?.file).toBe('review.md');
    expect(layers.scripts).toBeUndefined();
  });

  it('appends extra checks (multi-screen contains) on the html path', () => {
    const policy = policyForDeliverable('index.html', 'multi-screen arcade shooter with game over');
    const extra = [{ kind: 'contains', file: 'index.html', pattern: 'game over' }];
    const layers = retargetGateLayers(policy, 'index.html', bookGate, extra);
    expect(layers.checks.some((c) => c.kind === 'contains')).toBe(true);
  });
});
