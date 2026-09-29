import { describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ api: { synthesizeSpeechWithProgress: vi.fn() } }));

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
  it('speaks the rest of an update as soon as the tool call starts', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', "I've got the source packet. ", SPEAKER);
    t.text('s1', "Now I'll draft the outline.", SPEAKER);
    expect(said()).toEqual(["progress: I've got the source packet."]);
    // First tool-argument fragment: minutes before the write finishes.
    t.boundary('s1', SPEAKER);
    expect(said()).toEqual([
      "progress: I've got the source packet.",
      "progress: Now I'll draft the outline.",
    ]);
  });

  it('starts speaking a reply at its first finished sentence, not at the end of the turn', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Happy to — here is how I work', SPEAKER);
    expect(said()).toEqual([]);
    t.text('s1', '.\n\n## 1. The brief is the deliverable\n\nMy job is the', SPEAKER);
    expect(said()).toEqual([
      'progress: Happy to — here is how I work.',
      'progress: The brief is the deliverable.',
    ]);
    t.text('s1', ' *right brief*. A specialist does the rest', SPEAKER);
    t.complete('s1', 'ignored — the streamed words are the reply', SPEAKER);
    t.finish('s1');
    expect(said()).toEqual([
      'progress: Happy to — here is how I work.',
      'progress: The brief is the deliverable.',
      'progress: My job is the right brief.',
      'reply: A specialist does the rest.',
    ]);
  });

  it('speaks a long reply whole', () => {
    const { t, said } = tracker('replies');
    const sentence = 'This sentence is here to make the reply long enough to matter. ';
    const reply = sentence.repeat(12).trim();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', reply, SPEAKER);
    t.complete('s1', reply, SPEAKER);
    t.finish('s1');
    expect(said()).toEqual([`reply: ${reply}`]);
  });

  it('waits for whitespace before ending a sentence, so numbers stay whole', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Version 3.', SPEAKER);
    t.text('s1', '5 shipped... mostly. Next', SPEAKER);
    expect(said()).toEqual(['progress: Version 3.5 shipped...', 'progress: mostly.']);
  });

  it('never reads a code block aloud, and resumes after it closes', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Here is the fix:\n```ts\nconst a = 1. ', SPEAKER);
    t.text('s1', 'Oops.\n', SPEAKER);
    expect(said()).toEqual(['progress: Here is the fix:']);
    t.text('s1', '```\nThat is all. ', SPEAKER);
    expect(said()).toEqual(['progress: Here is the fix:', 'progress: That is all.']);
  });

  it('speaks prose that ran straight into markup once the markup is recognised', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Let me read the notes<tool', SPEAKER);
    expect(said()).toEqual([]);
    t.text('s1', '_call>\n<function=read_task_notes>', SPEAKER);
    expect(said()).toEqual(['progress: Let me read the notes.']);
  });

  it('holds at markup it cannot place yet rather than reading a parameter aloud', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Reading it now.\n<function=read_file>\n<parameter=path>\n', SPEAKER);
    t.text('s1', 'notes.txt\n</parameter>\n</function>\n', SPEAKER);
    t.boundary('s1', SPEAKER);
    expect(said()).toEqual(['progress: Reading it now.']);
  });

  it('holds at a JSON tool envelope streaming over several lines', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'One moment.\n{"name": "read_file",\n', SPEAKER);
    t.text('s1', ' "arguments": {"path": "notes.txt"}}\n', SPEAKER);
    t.boundary('s1', SPEAKER);
    expect(said()).toEqual(['progress: One moment.']);
  });

  it('splits prose from tool-call markup written into the text stream', () => {
    const { t, said } = tracker();
    t.beginTurn('s1', 'turn-1', SPEAKER);
    t.text('s1', 'Let me read the notes.\n<tool', SPEAKER);
    expect(said()).toEqual(['progress: Let me read the notes.']);
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

  it('keys live sentences by place, so a replay batched differently says nothing twice', () => {
    const live = tracker();
    live.t.beginTurn('s1', 'turn-1', SPEAKER);
    for (const piece of ['Fir', 'st. Sec', 'ond. Th', 'ird.']) live.t.text('s1', piece, SPEAKER);
    live.t.boundary('s1', SPEAKER);
    const replay = tracker();
    replay.t.beginTurn('s1', 'turn-1', SPEAKER);
    replay.t.text('s1', 'First. Second. Third.', SPEAKER);
    replay.t.boundary('s1', SPEAKER);
    expect(replay.spoken.map((r) => r.key)).toEqual(live.spoken.map((r) => r.key));
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

function request(
  key: string,
  kind: Request['kind'] = 'progress',
  place: { window?: number; sessionId?: string } = {},
): Request {
  const window = place.window ?? windowOf(key);
  return {
    key,
    kind,
    text: key,
    sessionId: place.sessionId ?? 's1',
    turnKey: 'turn-1',
    window,
    ...SPEAKER,
  };
}

/** Each distinct key is its own window unless a test says otherwise. */
const windows = new Map<string, number>();
function windowOf(key: string): number {
  if (!windows.has(key)) windows.set(key, windows.size);
  return windows.get(key)!;
}

/**
 * A player whose playback finishes only when the test says so. Synthesis is
 * instant and yields one clip per `|`-separated sentence of the text.
 */
function controlledPlayer() {
  const log: string[] = [];
  const finishers: Array<() => void> = [];
  const player: Player = {
    synthesize: async (r, _signal, onClip) => {
      log.push(`synth ${r.text}`);
      for (const sentence of r.text.split('|')) onClip(`wav:${sentence}`);
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
  const played = () => log.filter((line) => line.startsWith('play'));
  return { player, log, endCurrent, played };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('NarrationQueue', () => {
  it('makes the next window while the current one plays, and says each key once', async () => {
    const { player, log, endCurrent } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('q1'));
    queue.enqueue(request('q2'));
    queue.enqueue(request('q1'));
    await flush();
    expect(log).toEqual(['synth q1', 'play q1', 'synth q2']);
    await endCurrent();
    expect(log).toEqual(['synth q1', 'play q1', 'synth q2', 'play q2']);
    await endCurrent();
    expect(log).toHaveLength(4);
  });

  it('plays every sentence of one request in order', async () => {
    const { player, endCurrent, played } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('one|two|three', 'reply'));
    await flush();
    await endCurrent();
    await endCurrent();
    expect(played()).toEqual(['play one', 'play two', 'play three']);
  });

  it('sends the sentences of one window that piled up as a single request', async () => {
    const { player, log, endCurrent } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('b1', 'progress', { window: 90 }));
    await flush();
    queue.enqueue(request('b2', 'progress', { window: 91 }));
    queue.enqueue(request('b3', 'progress', { window: 91 }));
    await flush();
    // b2 was made the moment it arrived; b3 came while b2 waited to play.
    queue.enqueue(request('b4', 'progress', { window: 92 }));
    queue.enqueue(request('b5', 'progress', { window: 92 }));
    await endCurrent();
    expect(log.filter((line) => line.startsWith('synth'))).toEqual([
      'synth b1',
      'synth b2',
      'synth b3',
      'synth b4 b5',
    ]);
  });

  it('drops the oldest waiting update rather than falling behind', async () => {
    const { player, endCurrent, played } = controlledPlayer();
    const queue = new NarrationQueue(player);
    for (const key of ['d1', 'd2', 'd3', 'd4']) queue.enqueue(request(key));
    queue.enqueue(request('d-reply', 'reply'));
    await flush();
    for (let i = 0; i < 4; i++) await endCurrent();
    expect(played()).toEqual(['play d1', 'play d3', 'play d4', 'play d-reply']);
  });

  it('skips an update that waited too long, even once made, but never a reply', async () => {
    const { player, log, endCurrent, played } = controlledPlayer();
    let now = 0;
    const queue = new NarrationQueue(player, () => now);
    queue.enqueue(request('s-first'));
    queue.enqueue(request('s-stale'));
    queue.enqueue(request('s-reply', 'reply'));
    await flush();
    expect(log).toContain('synth s-stale');
    now = 60_000;
    await endCurrent();
    await endCurrent();
    expect(played()).toEqual(['play s-first', 'play s-reply']);
  });

  it('never drops the window a turn is still speaking in', async () => {
    const { player, endCurrent, played } = controlledPlayer();
    let now = 0;
    const queue = new NarrationQueue(player, () => now);
    queue.enqueue(request('w-first'));
    queue.enqueue(request('w-open'));
    await flush();
    now = 60_000;
    await endCurrent();
    expect(played()).toEqual(['play w-first', 'play w-open']);
  });

  it('stop cuts the voice and clears what was waiting', async () => {
    const { player, log, played } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('x1'));
    queue.enqueue(request('x2'));
    await flush();
    queue.stop();
    await flush();
    expect(played()).toEqual(['play x1']);
    queue.enqueue(request('x3'));
    await flush();
    expect(played()).toEqual(['play x1', 'play x3']);
    expect(log).not.toContain('play x2');
  });

  it('silences one cancelled session and lets another keep talking', async () => {
    const { player, endCurrent, played } = controlledPlayer();
    const queue = new NarrationQueue(player);
    queue.enqueue(request('c-a1', 'progress', { sessionId: 'a' }));
    queue.enqueue(request('c-b1', 'progress', { sessionId: 'b' }));
    queue.enqueue(request('c-a2', 'progress', { sessionId: 'a' }));
    await flush();
    queue.silence('a');
    await flush();
    await endCurrent();
    expect(played()).toEqual(['play c-a1', 'play c-b1']);
  });

  it('recognises a user message only the first time it is seen', () => {
    const queue = new NarrationQueue(controlledPlayer().player);
    expect(queue.noteTurn('s1', 'at-1')).toBe(true);
    expect(queue.noteTurn('s1', 'at-1')).toBe(false);
    expect(queue.noteTurn('s1', 'at-2')).toBe(true);
    expect(queue.noteTurn('s2', 'at-1')).toBe(true);
  });

  it('stops only when the last timeline lets go', async () => {
    const { player, endCurrent, played } = controlledPlayer();
    const queue = new NarrationQueue(player);
    const releaseA = queue.retain();
    const releaseB = queue.retain();
    queue.enqueue(request('r1'));
    queue.enqueue(request('r2'));
    queue.enqueue(request('r3'));
    await flush();
    // Releasing twice is one release: 'r2' was not cleared by a stop.
    releaseA();
    releaseA();
    await endCurrent();
    expect(played()).toEqual(['play r1', 'play r2']);
    releaseB();
    await flush();
    // 'r2' was cut and 'r3' dropped, so a new utterance starts at once.
    queue.enqueue(request('r4'));
    await flush();
    expect(played()).toEqual(['play r1', 'play r2', 'play r4']);
  });
});
