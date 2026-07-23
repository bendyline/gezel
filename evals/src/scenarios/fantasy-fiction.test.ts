import { describe, expect, it } from 'vitest';
import { DEFAULT_STORY_FORM } from '../story-checks.ts';
import { ELEMENT_ANCHORS, checkFantasyFictionStory } from './fantasy-fiction.ts';

/**
 * Reference story — proves every gate is winnable by a model that does
 * exactly what the kickoff asks: all four required elements dramatized,
 * title heading, prose with dialogue, inside the length band, no stock
 * opening.
 */
const REFERENCE_STORY = [
  '# What the Ice Remembers',
  '',
  'The dragon came to Castle Aldemere on the coldest night of the year, and she',
  'came on foot. That was the first wrong thing. Wick, who kept the gatehouse',
  'because nobody else would winter in it, watched through the murder-hole as',
  'something the size of a hay barn folded its wings flat against the snow and',
  'walked up the causeway like a petitioner, leaving melted footprints that',
  'froze again behind it into black glass.',
  '',
  'The second wrong thing was that it knocked.',
  '',
  '"I have no instructions about knocking," Wick said through the murder-hole,',
  'because forty years of gatekeeping had taught him that honesty buys time.',
  '"Armies, yes. Wolves, yes. Tax collectors, twice. Nobody knocks."',
  '',
  '"My name is Sarrenvex," said the dragon. Her voice was not a roar. It was',
  'low and cracked, like river ice settling. "I have come to make a bargain',
  'with the keeper of this castle. Fetch whoever that is."',
  '',
  '"That is complicated," said Wick, and it was. The Aldemere line had thinned',
  'and scattered and finally, last autumn, stopped. The heirs were quarreling',
  'in warm cities far to the south. What wintered in the castle now was Wick,',
  'two goats, and the frost, which came in through the walls a little further',
  'every year and bloomed on the tapestries like white moss eating a century of',
  'woven hunting scenes.',
  '',
  'Sarrenvex listened to all of it with her head tilted, one eye the color of',
  'a January sunset filling the murder-hole entirely. Then she said the thing',
  'that changed the shape of Wick\'s remaining years. "Good. It is the frost I',
  'have come about. Your castle is being eaten, gatekeeper, and not by winter.',
  'Something sleeps in your foundations that drinks warmth the way I drink',
  'rivers. I know it of old. I sealed it under this hill eight hundred years',
  'before there was a castle to stand on the seal, and the seal is failing,',
  'and I am too old now to mend it alone."',
  '',
  'The bargain she offered was simple the way a millstone is simple. She would',
  'go down through the cellars and give what remained of her fire to the seal —',
  'all of it, the whole banked furnace of her chest, centuries of heat spent in',
  "a single winter's work. A dragon's fire, once given, does not return; she",
  'would come up from the cellars as something slower and colder, a great grey',
  'lizard with opinions, and she would need a place to live out that diminished',
  'age. The castle would stop dying. In exchange, the castle would keep her.',
  '',
  '"I can\'t promise you the castle," Wick said. "It isn\'t mine."',
  '',
  '"You keep the gate. Whose is a castle, if not the one who decides what',
  'comes in?" She breathed, and for a moment the causeway stones steamed and',
  'the icicles along the gate arch let go and shattered musically on the',
  'flagstones. "Decide, gatekeeper. The frost will not wait on lawyers in the',
  'south, and neither will the thing that sends it."',
  '',
  'Wick thought about the tapestries, and the goats, and the particular way',
  'the great hall had begun to smell — not of damp, which he could have',
  'forgiven, but of nothing at all, the smell of a place with the memory',
  'sucked out of it. Then he drew the three bolts nobody had drawn for a',
  'dragon in the history of bolts, and swung the gate, and stood aside.',
  '',
  'She was in the cellars from Midwinter to the first thaw. Wick brought her',
  'nothing, because there was nothing she needed; but he sat at the top of the',
  'cellar stairs on the worst nights with a lamp and the older goat, listening',
  'to the sound of a fortune being spent below him, a slow roar going',
  'threadbare, hour by hour, like a man paying a debt in coins he had to mint',
  'from his own bones. The stones under his feet grew warm for the first time',
  'in his tenancy. He understood, sitting there, that he was listening to the',
  'price, and that it was being paid in full, and that nobody in the warm',
  'cities would ever believe what it had cost.',
  '',
  'She came up in March, smaller. That was the only word Wick could find for',
  'it and he knew it was the wrong one. The furnace-light behind her scales',
  'had gone out; what walked out of the cellar door was the color of the',
  'winter sea, and it moved carefully, the way the old move on ice. But the',
  'frost had gone from the tapestries, and the walls had stopped their eating,',
  'and when the snow finally slid from the roofs it did not come back.',
  '',
  '"The seal will hold three hundred years," said Sarrenvex, settling into the',
  'great hall\'s hearth-alcove, which fit her now. "After that, it is somebody',
  'else\'s bargain. Write it down somewhere the lawyers will find it."',
  '',
  'The goats accepted her within the week, which Wick took for a judgment of',
  'character; goats are not sentimental. She earned her keep in small, odd',
  'ways — the well never froze again, meat kept longer in the larder she',
  'slept beside, and rats abandoned the granary with a haste that suggested',
  'urgent business elsewhere. In the evenings she told him, in that cracked',
  'river-ice voice, what the hill had been before the castle, and Wick, who',
  'had never been told anything by anyone, listened like a boy.',
  '',
  'So Wick wrote it in the gate ledger, between a delivery of salt fish and a',
  "note about the north wall, in his careful gatekeeper's hand: the terms, the",
  'price, the paying of it. And when the heirs finally came north in the',
  'summer, quarreling all the way up the causeway about which of them owned',
  'what, they found the gate open, the hall warm, and a grey dragon asleep by',
  'the hearth with a ledger under her claw, and not one of them, reading it,',
  'could think of a single word to say.',
].join('\n');

describe('fantasy-fiction grader', () => {
  it('the reference story passes every gate', () => {
    const check = checkFantasyFictionStory(REFERENCE_STORY);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('required-elements');
  });

  it('the reference story genuinely sits inside the length band', () => {
    expect(REFERENCE_STORY.length).toBeGreaterThanOrEqual(DEFAULT_STORY_FORM.minBytes);
    expect(REFERENCE_STORY.length).toBeLessThanOrEqual(DEFAULT_STORY_FORM.maxBytes);
  });

  it('the reference story satisfies each anchor individually', () => {
    for (const anchor of ELEMENT_ANCHORS) {
      expect(anchor.pattern.test(REFERENCE_STORY), `anchor "${anchor.id}"`).toBe(true);
    }
  });

  it('all four elements are required, not a quorum — dropping just the bargain fails', () => {
    const noBargain = REFERENCE_STORY.replace(/bargain/gi, 'arrangement');
    const check = checkFantasyFictionStory(noBargain);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/required-elements/);
    expect(check.failReason).toMatch(/bargain/);
  });

  it('a dragonless story fails with the missing element named', () => {
    const noDragon = REFERENCE_STORY.replace(/dragon(’s|'s)?/gi, 'wyrm');
    const check = checkFantasyFictionStory(noDragon);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/the dragon/);
  });

  it('a cliché opening fails even when everything else is intact', () => {
    const cliched = REFERENCE_STORY.replace(
      'The dragon came to Castle Aldemere',
      'Once upon a time, the dragon came to Castle Aldemere',
    );
    const check = checkFantasyFictionStory(cliched);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/no-cliche-opening/);
  });

  it('an outline instead of prose fails the prose-form gate', () => {
    const outline = `# The Winter Bargain\n\n${'- the dragon arrives at the castle in winter and offers a bargain to the gatekeeper\n'.repeat(70)}`;
    const check = checkFantasyFictionStory(outline);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('prose-form');
  });

  it('stripping the dialogue fails the dialogue gate', () => {
    const noDialogue = REFERENCE_STORY.replace(/["“][^"“”\n]{2,}["”]/g, 'something unsaid');
    const check = checkFantasyFictionStory(noDialogue);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('dialogue');
  });
});
