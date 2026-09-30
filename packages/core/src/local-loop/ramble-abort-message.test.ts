import { describe, expect, it } from 'vitest';
import { buildRambleAbortMessage } from './ramble-abort-message.js';

const build = (
  knownToolNames: string[],
  extra: { deliverableFile?: string; deliverableIsArtifact?: boolean } = {},
) =>
  buildRambleAbortMessage({
    providerLabel: '[Mac AI]',
    charCount: 12248,
    knownToolNames: new Set(knownToolNames),
    ...extra,
  });

describe('buildRambleAbortMessage', () => {
  describe('the invariant head', () => {
    // `describeDelegateFailureForAsker` and manager.ts's corrective
    // classifier both pattern-match this wording.
    it('keeps the phrasing downstream consumers match on', () => {
      const msg = build(['write_file']);
      expect(msg).toContain(
        '[Mac AI] aborting — the gezel emitted 12248 characters of prose this turn without ' +
          'calling any action tool. Stop planning.',
      );
      expect(msg).toMatch(/emitted\s+\d+\s+characters of prose this turn/);
    });
  });

  describe('the wild-caught case: read-only project, artifact deliverable', () => {
    // qwen3.8-27b-q4 on a PR-review batch step. The old static copy told
    // it to call `write_file` (not wired), start with a handoff tool
    // (none wired), and NOT to use `write_artifact` — the step's only
    // deliverable tool.
    const ROSTER = ['read_artifact', 'write_artifact', 'ask_user_question', 'advance_task_step'];
    const STEP = {
      deliverableFile: 'tasks/35/pr-review/observations-11.md',
      deliverableIsArtifact: true,
    };

    it('names write_artifact and the exact deliverable path', () => {
      const msg = build(ROSTER, STEP);
      expect(msg).toContain('`write_artifact`');
      expect(msg).toContain('tasks/35/pr-review/observations-11.md');
      expect(msg).toMatch(/call `write_artifact` NOW/);
    });

    it('never names write_file when it is not on the roster', () => {
      expect(build(ROSTER, STEP)).not.toContain('write_file');
    });

    it('never forbids write_artifact when it is the deliverable tool', () => {
      expect(build(ROSTER, STEP)).not.toMatch(/Do not save.*write_artifact/i);
    });

    it('never offers a handoff tool when none is wired', () => {
      expect(build(ROSTER, STEP)).not.toMatch(/handoff/i);
    });
  });

  describe('deliverable routing', () => {
    it('points a workspace deliverable at write_file', () => {
      const msg = build(['write_file', 'write_artifact'], {
        deliverableFile: 'src/index.ts',
      });
      expect(msg).toContain('`write_file`');
      expect(msg).toContain('src/index.ts');
    });

    it('falls back to the wired writer when the step drawer has none', () => {
      // Workspace deliverable but writes are off: name the writer that
      // exists rather than one that does not.
      const msg = build(['write_artifact'], { deliverableFile: 'notes/review.md' });
      expect(msg).toContain('`write_artifact`');
      expect(msg).not.toContain('write_file');
    });

    it('falls through to the generic route when neither writer is wired', () => {
      const msg = build(['ask_user_question'], {
        deliverableFile: 'notes/review.md',
        deliverableIsArtifact: true,
      });
      expect(msg).not.toContain('write_artifact');
      expect(msg).toContain('`ask_user_question`');
    });
  });

  describe('generic routes, no active step', () => {
    it('keeps the write_file guidance and the artifact caveat when both are wired', () => {
      const msg = build(['write_file', 'write_artifact']);
      expect(msg).toMatch(/call `write_file` NOW/);
      expect(msg).toMatch(/Do not save source or project files with `write_artifact`/);
    });

    it('drops the artifact caveat when write_artifact is not even wired', () => {
      expect(build(['write_file'])).not.toContain('write_artifact');
    });

    it('sends a writes-off session to write_artifact instead of warning it off', () => {
      const msg = build(['write_artifact', 'ask_user_question']);
      expect(msg).toMatch(/`write_artifact` is where your work belongs/);
      expect(msg).toMatch(/call it NOW/);
      expect(msg).not.toContain('write_file');
    });

    it('names the actual delegation tool when there is no write surface', () => {
      const msg = build(['delegate_to_builder', 'ask_user_question']);
      expect(msg).toContain('`delegate_to_builder`');
    });

    it('falls back to ask_user_question when nothing else can act', () => {
      const msg = build(['ask_user_question', 'read_file']);
      expect(msg).toContain('`ask_user_question`');
    });

    it('names no tool at all when the roster has nothing actionable', () => {
      const msg = build(['read_file', 'list_dir']);
      expect(msg).toMatch(/No write or handoff tool is wired/);
      expect(msg).not.toContain('`write_file`');
      expect(msg).not.toContain('`write_artifact`');
      expect(msg).not.toContain('`ask_user_question`');
    });
  });

  it('never names a tool outside the supplied roster', () => {
    const rosters = [
      ['write_file'],
      ['write_artifact'],
      ['delegate_to_builder'],
      ['ask_user_question'],
      ['read_file'],
      ['write_file', 'write_artifact', 'ask_user_question'],
    ];
    const candidates = [
      'write_file',
      'write_artifact',
      'ask_user_question',
      'delegate_to_builder',
      'run_script',
    ];
    for (const roster of rosters) {
      const msg = build(roster);
      for (const tool of candidates) {
        if (roster.includes(tool)) continue;
        expect(msg, `roster=${roster.join(',')} leaked ${tool}`).not.toContain(`\`${tool}\``);
      }
    }
  });
});
