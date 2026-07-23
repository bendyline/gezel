import { CatalogService } from '@bendyline/gezel-catalog';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Rules-engine tests for the SHIPPED checkers game-store. The engine is a
 * sentinel-delimited pure-JS block inside the bundled manifest's inline
 * script; we slice it out of the resolved catalog manifest and execute it
 * with `new Function` — the tested bytes ARE the shipped bytes, on every
 * platform (the sandboxed ScriptRunner e2e is darwin-only).
 */

interface Sequence {
  from: string;
  to: string;
  path: string[];
  captures: string[];
}

interface Rules {
  buildInitial(): string;
  legalMovesFor(squares: string, side: 'user' | 'ai', forceCaptures?: boolean): Sequence[];
  applySequence(squares: string, seq: Sequence): string;
  statusAfter(squares: string, side: 'user' | 'ai', forceCaptures?: boolean): string;
  describeMove(seq: Sequence): string;
  renderAscii(squares: string): string;
  parseSq(name: string): { x: number; y: number } | null;
  sqName(x: number, y: number): string;
}

let rules: Rules;
let seed: { squares: string; forceCaptures: boolean; legalMoves: Sequence[] };

function put(squares: string, name: string, ch: string): string {
  const p = rules.parseSq(name);
  if (!p) throw new Error(`bad square ${name}`);
  const i = p.y * 8 + p.x;
  return squares.slice(0, i) + ch + squares.slice(i + 1);
}

beforeAll(async () => {
  const catalog = new CatalogService();
  const detail = await catalog.get('project-type', 'checkers');
  if (!detail || detail.manifest.kind !== 'project-type') throw new Error('checkers not resolved');
  const source = detail.manifest.scripts?.['game-store'];
  if (!source) throw new Error('game-store script missing');
  const start = source.indexOf('// ── checkers-rules-start ──');
  const end = source.indexOf('// ── checkers-rules-end ──');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  rules = new Function(
    `${source.slice(start, end)}; return { buildInitial, legalMovesFor, applySequence, statusAfter, describeMove, renderAscii, parseSq, sqName };`,
  )() as Rules;

  const seedBuf = await catalog.readItemFile(
    'project-type',
    'checkers',
    'game.json',
    detail.sourceId,
    detail.manifest.version,
  );
  if (!seedBuf) throw new Error('seed game.json missing');
  seed = JSON.parse(seedBuf.toString('utf8'));
});

describe('checkers rules engine (shipped bytes)', () => {
  it('builds the standard opening position', () => {
    const initial = rules.buildInitial();
    expect(initial).toHaveLength(64);
    expect([...initial].filter((c) => c === 'b')).toHaveLength(12);
    expect([...initial].filter((c) => c === 'r')).toHaveLength(12);
    expect([...initial].filter((c) => c === 'R' || c === 'B')).toHaveLength(0);
  });

  it('the committed seed matches the engine exactly (position + opening moves)', () => {
    expect(seed.squares).toBe(rules.buildInitial());
    expect(seed.legalMoves).toEqual(rules.legalMovesFor(seed.squares, 'user'));
    expect(seed.forceCaptures).toBe(true);
    expect(seed.legalMoves).toHaveLength(7);
  });

  it('forced captures mask quiet moves, for every capturer', () => {
    const sq = put(rules.buildInitial(), 'd4', 'b');
    const moves = rules.legalMovesFor(sq, 'user');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.captures.length > 0)).toBe(true);
    expect(moves.some((m) => m.from === 'c3' && m.to === 'e5')).toBe(true);
    expect(moves.some((m) => m.from === 'e3' && m.to === 'c5')).toBe(true);
  });

  it('optional captures keep both jumps and quiet moves legal', () => {
    const sq = put(rules.buildInitial(), 'd4', 'b');
    const moves = rules.legalMovesFor(sq, 'user', false);
    expect(moves.some((m) => m.captures.length > 0)).toBe(true);
    expect(moves.some((m) => m.captures.length === 0)).toBe(true);
    expect(moves.some((m) => m.from === 'g3' && m.to === 'f4')).toBe(true);
  });

  it('multi-jumps produce a complete sequence with each capture', () => {
    let sq = rules.buildInitial();
    sq = put(sq, 'd4', 'b');
    sq = put(sq, 'f6', 'b');
    sq = put(sq, 'g7', '.');
    const seq = rules.legalMovesFor(sq, 'user').find((m) => m.captures.length === 2);
    expect(seq).toBeDefined();
    expect(seq?.from).toBe('c3');
    expect(seq?.to).toBe('g7');
    expect(seq?.captures).toEqual(['d4', 'f6']);
    expect(rules.describeMove(seq!)).toBe('c3xe5xg7 (captures d4, f6)');

    const after = rules.applySequence(sq, seq!);
    const d4 = rules.parseSq('d4')!;
    const f6 = rules.parseSq('f6')!;
    expect(after[d4.y * 8 + d4.x]).toBe('.');
    expect(after[f6.y * 8 + f6.x]).toBe('.');
  });

  it('crowning ends the jump sequence and produces a king', () => {
    let sq = '.'.repeat(64);
    sq = put(sq, 'd6', 'r');
    sq = put(sq, 'c7', 'b');
    // A continuation target that must NOT be taken — the move ends on crowning.
    sq = put(sq, 'a7', 'b');
    const crown = rules.legalMovesFor(sq, 'user').find((m) => m.to === 'b8');
    expect(crown).toBeDefined();
    expect(crown?.captures).toEqual(['c7']);
    const after = rules.applySequence(sq, crown!);
    const b8 = rules.parseSq('b8')!;
    expect(after[b8.y * 8 + b8.x]).toBe('R');
  });

  it('kings move and capture in all four directions', () => {
    let sq = '.'.repeat(64);
    sq = put(sq, 'd4', 'R');
    expect(rules.legalMovesFor(sq, 'user')).toHaveLength(4);

    sq = put(sq, 'c3', 'b');
    const jumps = rules.legalMovesFor(sq, 'user');
    // Forced capture backwards (toward red's own side).
    expect(jumps.every((m) => m.captures.length > 0)).toBe(true);
    expect(jumps.some((m) => m.to === 'b2')).toBe(true);
  });

  it('the side to move with no legal move has lost', () => {
    let sq = '.'.repeat(64);
    sq = put(sq, 'a1', 'r');
    sq = put(sq, 'b2', 'b');
    sq = put(sq, 'c3', 'b');
    expect(rules.statusAfter(sq, 'user')).toBe('ai_won');
    // And symmetric: no pieces at all is also a loss.
    expect(rules.statusAfter('.'.repeat(64), 'ai')).toBe('user_won');
  });

  it('renders a stable coordinate ascii board', () => {
    const ascii = rules.renderAscii(rules.buildInitial());
    const lines = ascii.split('\n');
    expect(lines[0]).toBe('  a b c d e f g h');
    expect(lines[1]).toBe('8 . b . b . b . b');
    expect(lines[8]).toBe('1 r . r . r . r .');
    expect(ascii).toContain('Capitals are kings');
  });

  it('keeps the shipped script comfortably under the inline budget', async () => {
    const catalog = new CatalogService();
    const detail = await catalog.get('project-type', 'checkers');
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('unresolved');
    expect((detail.manifest.scripts?.['game-store'] ?? '').length).toBeLessThan(48 * 1024);
  });
});
