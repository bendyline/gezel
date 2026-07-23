import type { TerminalMessageEvent } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { TerminalEventBus } from './events.js';

function commandEvent(projectId: string, id: string): TerminalMessageEvent {
  return {
    kind: 'message',
    projectId,
    threadId: '_root',
    workingDir: '',
    message: {
      id,
      kind: 'command',
      content: id,
      at: '2026-07-22T00:00:00.000Z',
    },
  };
}

describe('TerminalEventBus', () => {
  it('replays recent persisted messages to a late project subscriber', () => {
    const bus = new TerminalEventBus();
    bus.publish(commandEvent('alpha', 'list_memories'));

    const received: TerminalMessageEvent[] = [];
    bus.subscribeProject('alpha', (event) => {
      if (event.kind === 'message') received.push(event);
    });

    expect(received.map((event) => event.message.id)).toEqual(['list_memories']);
  });

  it('keeps replay scoped to the requested project', () => {
    const bus = new TerminalEventBus();
    bus.publish(commandEvent('alpha', 'alpha-command'));
    bus.publish(commandEvent('beta', 'beta-command'));

    const received: string[] = [];
    bus.subscribeProject('beta', (event) => {
      if (event.kind === 'message') received.push(event.message.id);
    });

    expect(received).toEqual(['beta-command']);
  });

  it('bounds the replay buffer per project', () => {
    const bus = new TerminalEventBus();
    for (let index = 0; index < 105; index += 1) {
      bus.publish(commandEvent('alpha', `command-${index}`));
    }

    const received: string[] = [];
    bus.subscribeProject('alpha', (event) => {
      if (event.kind === 'message') received.push(event.message.id);
    });

    expect(received).toHaveLength(100);
    expect(received[0]).toBe('command-5');
    expect(received.at(-1)).toBe('command-104');
  });
});
