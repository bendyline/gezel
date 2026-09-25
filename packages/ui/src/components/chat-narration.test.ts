import { describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { synthesizeSpeech: vi.fn() } }));

const { ChatNarrationTracker, NarrationQueue } = await import('./chat-narration.js');
type Mode = import('./chat-narration.js').ChatNarrationMode;
type Request = import('./chat-narration.js').NarrationRequest;
type Player = import('./chat-narration.js').NarrationPlayer;

const SPEAKER = { gezelId: 'guadalupe', projectId: 'default' };

function tracker(mode: Mode = 'progress') {
  const spoken: Request[] = [];
  const t = new ChatNarrationTracker({ mode: () => mode, speak: (r) => spoken.push(r) });
  return { t, spoken, said: () => spoken.map((r) => `${r.kind}: ${r.text}`) };
}

describe('ChatNarrationTracker', () => {
  it('speaks the update before a tool call as soon as the call starts', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', "I've got the source packet. ", SPEAKER);
    t.text('s1', "Now I'll draft the outline.", SPEAKER);
    expect(said()).toEqual([]);
    // First tool-argument fragment: minutes before the write finishes.
    t.boundary('s1', SPEAKER);
    expect(said()).toEqual(["progress: I've got the source packet. Now I'll draft the outline."]);
  });

  it('splits prose from tool-call markup written into the text stream', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Let me read the notes.\n<tool', SPEAKER);
    expect(said()).toEqual([]);
    t.text('s1', '_call>\n<function=read_task_notes>\n<parameter=ref>', SPEAKER);
    expect(said()).toEqual(['progress: Let me read the notes.']);
    t.text('s1', 'default/18</parameter>\n</function>\n</tool_call>', SPEAKER);
    t.boundary('s1', SPEAKER);
    expect(said()).toEqual(['progress: Let me read the notes.']);
  });

  it('reads the words after the last tool call as the reply, once the turn is done', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Checking the file.', SPEAKER);
    t.boundary('s1', SPEAKER);
    t.text('s1', 'All **done** — the outline is saved.', SPEAKER);
    t.complete(
      's1',
      'Checking the file.<tool_call>…</tool_call>All **done** — the outline is saved.',
      SPEAKER,
    );
    expect(said()).toEqual(['progress: Checking the file.']);
    t.finish('s1');
    expect(said()).toEqual([
      'progress: Checking the file.',
      'reply: All done — the outline is saved.',
    ]);
  });

  it('skips a fixed checkpoint line the gezel never said once updates were spoken', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', "Now I'll draft the outline.", SPEAKER);
    t.boundary('s1', SPEAKER);
    t.complete('s1', 'Checkpoint written for validation.', SPEAKER);
    t.finish('s1');
    expect(said()).toEqual(["progress: Now I'll draft the outline."]);
  });

  it('falls back to the committed message when nothing streamed', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.complete('s1', 'Here is the plan.', SPEAKER);
    t.finish('s1');
    expect(said()).toEqual(['reply: Here is the plan.']);
  });

  it('speaks a reply as an update when the turn keeps working after it', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'First pass is done.', SPEAKER);
    t.complete('s1', 'First pass is done.', SPEAKER);
    t.boundary('s1', SPEAKER);
    t.text('s1', 'Both passes are done.', SPEAKER);
    t.complete('s1', 'Both passes are done.', SPEAKER);
    t.finish('s1');
    expect(said()).toEqual(['progress: First pass is done.', 'reply: Both passes are done.']);
  });

  it('speaks only the reply in replies mode, and nothing when off', () => {
    const replies = tracker('replies');
    const off = tracker('off');
    for (const { t } of [replies, off]) {
      t.beginTurn('s1', 'turn-1', SPEAKER);
      t.text('s1', 'Checking the file.', SPEAKER);
      t.boundary('s1', SPEAKER);
      t.text('s1', 'Done.', SPEAKER);
      t.complete('s1', 'Checking the file. Done.', SPEAKER);
      t.finish('s1');
    }
    expect(replies.said()).toEqual(['reply: Done.']);
    expect(off.said()).toEqual([]);
  });

  it('rebuilds the same utterances from a replay after a reconnect', () => {
    const { t, spoken } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Reading the brief.', SPEAKER);
    t.boundary('s1', SPEAKER);
    t.text('s1', 'Now the out', SPEAKER);
    t.resetWindows();
    // The bus replays the turn from the start, deltas coalesced.
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Reading the brief.', SPEAKER);
    t.boundary('s1', SPEAKER);
    t.text('s1', 'Now the outline.', SPEAKER);
    t.boundary('s1', SPEAKER);
    expect(spoken.map((r) => r.text)).toEqual([
      'Reading the brief.',
      'Reading the brief.',
      'Now the outline.',
    ]);
    expect(spoken[0]!.key).toBe(spoken[1]!.key);
  });

  it('does not reset a turn when the same user message is published again', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Looking at the images.', SPEAKER);
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.boundary('s1', SPEAKER);
    expect(said()).toEqual(['progress: Looking at the images.']);
  });

  it('forgets a cancelled turn', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.complete('s1', 'Partial answer.', SPEAKER);
    t.forget('s1');
    t.finish('s1');
    expect(said()).toEqual([]);
  });
});

function request(key: string, kind: Request['kind'] = 'progress'): Request {
  return { key, kind, text: key, ...SPEAKER };
}

/** A player whose synth and playback finish only when the test says so. */
function controlledPlayer() {
  const log: string[] = [];
  const finishers: Array<() => void> = [];
  const player: Player = {
    synthesize: async (r) => {
      log.push(`synth ${r.text}`);
      return `wav:${r.text}`;
    },
    play: (wav, signal) =>
      new Promise<void>((resolve) => {
        log.push(`play ${wav.slice(4)}`);
        const done = () => resolve();
        signal.addEventListener('abort', done, { once: true });
        finishers.push(done);
      }),
  };
  const endCurrent = async () => {
    finishers.shift()?.();
    await flush();
  };
  return { player, log, endCurrent };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('NarrationQueue', () => {
  it('speaks one utterance at a time, in order, each key once', async () => {
    const { player, log, endCurrent } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('a'));
    queue.enqueue(request('b'));
    queue.enqueue(request('a'));
    await flush();
    expect(log).toEqual(['synth a', 'play a']);
    await endCurrent();
    expect(log).toEqual(['synth a', 'play a', 'synth b', 'play b']);
    await endCurrent();
    expect(log).toHaveLength(4);
  });

  it('drops the oldest waiting update rather than falling behind', async () => {
    const { player, log, endCurrent } = controlledPlayer();
    const queue = new NarrationQueue(player);
    for (const key of ['a', 'b', 'c', 'd']) queue.enqueue(request(key));
    queue.enqueue(request('reply', 'reply'));
    await flush();
    for (let i = 0; i < 4; i++) await endCurrent();
    expect(log.filter((line) => line.startsWith('play'))).toEqual([
      'play a',
      'play c',
      'play d',
      'play reply',
    ]);
  });

  it('skips an update that waited too long, but never a reply', async () => {
    const { player, log, endCurrent } = controlledPlayer();
    let now = 0;
    const queue = new NarrationQueue(player, () => now);
    queue.enqueue(request('a'));
    queue.enqueue(request('stale'));
    queue.enqueue(request('reply', 'reply'));
    await flush();
    now = 60_000;
    await endCurrent();
    await endCurrent();
    expect(log.filter((line) => line.startsWith('play'))).toEqual(['play a', 'play reply']);
  });

  it('stop cuts the voice and clears what was waiting', async () => {
    const { player, log } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('a'));
    queue.enqueue(request('b'));
    await flush();
    queue.stop();
    await flush();
    expect(log).toEqual(['synth a', 'play a']);
    queue.enqueue(request('c'));
    await flush();
    expect(log).toEqual(['synth a', 'play a', 'synth c', 'play c']);
  });

  it('recognises a user message only the first time it is seen', () => {
    const queue = new NarrationQueue(controlledPlayer().player);
    expect(queue.noteTurn('s1', 'at-1')).toBe(true);
    expect(queue.noteTurn('s1', 'at-1')).toBe(false);
    expect(queue.noteTurn('s1', 'at-2')).toBe(true);
    expect(queue.noteTurn('s2', 'at-1')).toBe(true);
  });

  it('stops only when the last timeline lets go', async () => {
    const { player, log, endCurrent } = controlledPlayer();
    const queue = new NarrationQueue(player);
    const releaseA = queue.retain();
    const releaseB = queue.retain();
    queue.enqueue(request('a'));
    queue.enqueue(request('b'));
    queue.enqueue(request('c'));
    await flush();
    // Releasing twice is one release: 'b' was not cleared by a stop.
    releaseA();
    releaseA();
    await endCurrent();
    expect(log).toEqual(['synth a', 'play a', 'synth b', 'play b']);
    releaseB();
    await flush();
    // 'b' was cut and 'c' dropped, so a new utterance starts at once.
    queue.enqueue(request('d'));
    await flush();
    expect(log).toEqual(['synth a', 'play a', 'synth b', 'play b', 'synth d', 'play d']);
  });
});
