import { describe, expect, it } from 'vitest';
import { PLAIN_WORDS_RELAY } from './relay-text.js';

describe('PLAIN_WORDS_RELAY', () => {
  it('is one plain sentence naming the ids to leave out, without showing one', () => {
    expect(PLAIN_WORDS_RELAY).toMatch(/^[^.]+\.$/);
    expect(PLAIN_WORDS_RELAY).toContain('plain words');
    for (const kind of ['task', 'project', 'craftbook']) expect(PLAIN_WORDS_RELAY).toContain(kind);
    // An example id or file name here is one a model would copy into its reply.
    expect(PLAIN_WORDS_RELAY).not.toMatch(/[`/]|\.json/);
  });
});
