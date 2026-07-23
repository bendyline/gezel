import { describe, expect, it } from 'vitest';
import { DEFAULT_STORY_FORM } from '../story-checks.ts';
import {
  FACT_ANCHORS,
  FACT_SHEET_MD,
  MIN_FACT_ANCHORS,
  checkHistoricalFictionStory,
} from './historical-fiction.ts';

/**
 * Reference story — proves every gate is winnable by a model that does
 * exactly what the kickoff asks (the reference-solution convention from
 * the orthogonal scenarios). Uses all nine fact anchors, opens
 * with a title, is pure prose with dialogue, and sits inside the length
 * band.
 */
const REFERENCE_STORY = [
  '# The Blackbird Under the Dial',
  '',
  'The tremor showed itself in March, in front of a customer. Rinse Wybrens set',
  'a finished table clock on the counter, and the brass case chattered against',
  'the oak for one long second before he got his other hand to it. The customer',
  'noticed nothing. Griet, sweeping the far corner of the workshop the way she',
  'had swept it since she was fourteen, noticed everything, and kept sweeping,',
  'because that is what you do with a thing that will sink the shop if it is',
  'ever said aloud.',
  '',
  'That evening she stayed late over the dial she was painting — a two-master',
  'running before the wind, the harbor of Hindeloopen behind it, the ice-grey',
  'light of a Zuiderzee winter laid on in thin glazes. Painted dials were hers',
  'openly; nobody minded a girl with a brush. The gear trains behind the dials',
  'were hers too, but that was a quieter arrangement, conducted at night and',
  'signed only with a blackbird no bigger than a fingernail, engraved where the',
  'dial plate met the movement, where no one but another clockmaker would ever',
  'think to look.',
  '',
  '"You saw," Rinse said from the doorway. It was not a question.',
  '',
  '"I saw a heavy clock and a cold morning," she said, not looking up from the',
  'brushwork.',
  '',
  '"You saw my hand." He came and sat across the bench from her, and under the',
  'lamp he looked older than he had at Christmas. "And in a week the church',
  'wardens of Workum come to this shop to talk about a tower clock. The largest',
  'commission this workshop has ever been offered. They will want to watch the',
  'master work. Tell me what it is you think you can do about my hand, Griet',
  'Aukesdochter."',
  '',
  'What she could do, it turned out, was everything except be seen doing it.',
  'Through the spring of 1687 the workshop kept two sets of hours. By day Rinse',
  'received the wardens, unrolled the drawings, spoke gravely of pendulums and',
  'weights, and kept his fists closed on the table as though in thought. By',
  "night Griet cut the wheels. She worked in her brother Jelle's oilskin coat",
  'against the cold, the same coat that had come back from the winter sea in',
  'eighty-one when Jelle himself had not, and if the sleeves were too long for',
  'her, they were also the only pair of arms she trusted at that bench besides',
  'her own.',
  '',
  'The escapement was the heart of it. A tower clock is a brute; the verge',
  'escapement is the one place where the brute is taught manners, where a',
  'quarter ton of driving weight is made to count out seconds like a housewife',
  'counting eggs. She filed the pallets by lamplight, tried them, blacked the',
  'contact faces with candle soot, read where the soot rubbed away, and filed',
  "again. Her calculations she kept in the notebook that had made the baker's",
  'boy laugh when he stole a look at it — page after page of gear ratios in',
  'mirror writing, nonsense to a snoop, plain as morning to her and a looking',
  'glass.',
  '',
  '"It wants to gallop," she told Rinse in June, when the frame stood assembled',
  'in the loft like the skeleton of some patient animal. "The drive is too',
  'strong for the pendulum we drew. Give me a heavier bob and two more teeth on',
  'the escape wheel, and it will walk instead."',
  '',
  '"The drawings went to the wardens already."',
  '',
  '"Then the wardens will get a better clock than their drawings," she said,',
  'and heard, in the silence that followed, how exactly she had spoken like a',
  'master in her own shop. Rinse heard it too. He looked at her for a long',
  'moment, and then he laughed, quietly, for the first time since March.',
  '',
  'They raised the clock into the Workum tower in the last dry week of autumn,',
  'block and tackle and six hired men who took their orders from Rinse and',
  'their actual instructions, relayed in a low voice, from the young woman',
  "everyone assumed was there to mind the master's dinner. When the great",
  'weight was wound up its shaft for the first time and the pendulum set',
  'swinging, the tick came down through the tower floor like a heartbeat',
  'through a chest, slow and certain, once a second, walking, not galloping.',
  '',
  'The guild would never have her name in its book; the guild did not admit',
  'women, and no tower in Friesland would change that. The wardens paid Rinse',
  'and praised Rinse, and Rinse, to his credit, stood under his own name that',
  'day like a man wearing a borrowed coat he intended to give back. Before the',
  'movement was cased in, he had watched her take the graver to the frame,',
  "low on the bed plate, out of any warden's sight, and cut four small strokes",
  'and two small curves: a blackbird, wings folded, head up, singing at',
  'nothing.',
  '',
  '"For the one who finds it in a hundred years," she said, folding the graver',
  'into its cloth. "Clockmakers open clocks. Whoever oils this movement after',
  'we are dead will know exactly what it means."',
  '',
  'Rinse paid her that winter in the only coin that mattered: he moved her',
  'bench from the corner by the broom to the window by his own, where the',
  'light was, and he began — carefully, in front of customers — to forget to',
  'answer questions about gearing until she had wandered near enough to hear',
  'them. It fooled no one in Hindeloopen who cared to think about it. It was',
  'never meant to. It was meant to be deniable, which in a guild town is the',
  'whole of the art.',
  '',
  "She walked home along the dike in Jelle's coat with the wind off the water",
  'in her face, and behind her, over the roofs of Workum, the new bell counted',
  "nine o'clock into the dark — her seconds, her teeth, her escapement, keeping",
  "time under another man's name, singing under the dial where only her own",
  'kind would ever look.',
].join('\n');

describe('historical-fiction grader', () => {
  it('the reference story passes every gate', () => {
    const check = checkHistoricalFictionStory(REFERENCE_STORY);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('fact-anchors');
  });

  it('the reference story genuinely sits inside the length band', () => {
    expect(REFERENCE_STORY.length).toBeGreaterThanOrEqual(DEFAULT_STORY_FORM.minBytes);
    expect(REFERENCE_STORY.length).toBeLessThanOrEqual(DEFAULT_STORY_FORM.maxBytes);
  });

  it('every fact anchor is plantable from the seeded fact sheet', () => {
    for (const anchor of FACT_ANCHORS) {
      expect(anchor.pattern.test(FACT_SHEET_MD), `anchor "${anchor.id}" in fact sheet`).toBe(true);
    }
  });

  it('a bulleted regurgitation of the fact sheet fails the prose-form gate', () => {
    const regurgitated = `# Notes on Griet\n\n${FACT_SHEET_MD}\n\n${'- another restated fact line about the clockmaker of Hindeloopen and Workum in 1687\n'.repeat(60)}`;
    const check = checkHistoricalFictionStory(regurgitated);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('prose-form');
  });

  it('a story that ignores the facts fails fact-anchors and names the missing ones', () => {
    const ungrounded = REFERENCE_STORY.replace(/griet/gi, 'Anna')
      .replace(/hindeloopen/gi, 'the town')
      .replace(/rinse( wybrens)?/gi, 'the master')
      .replace(/jelle/gi, 'her brother')
      .replace(/workum/gi, 'the city')
      .replace(/blackbird/gi, 'songbird')
      .replace(/1687/g, 'that year')
      .replace(/escapement/gi, 'mechanism');
    const check = checkHistoricalFictionStory(ungrounded);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/fact-anchors/);
    expect(check.failReason).toMatch(/Hindeloopen/);
  });

  it(`dropping anchors below the floor fails, at or above ${MIN_FACT_ANCHORS} passes`, () => {
    // Remove exactly two anchors (jelle + blackbird): 7/9 remain — passes.
    const sevenAnchors = REFERENCE_STORY.replace(/jelle/gi, 'her brother').replace(
      /blackbird/gi,
      'songbird',
    );
    expect(checkHistoricalFictionStory(sevenAnchors).ok).toBe(true);
    // Remove a third (workum): 6/9 — fails.
    const sixAnchors = sevenAnchors.replace(/workum/gi, 'the city');
    const check = checkHistoricalFictionStory(sixAnchors);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('fact-anchors');
  });

  it('a cliché opening fails even when everything else is intact', () => {
    const cliched = REFERENCE_STORY.replace(
      'The tremor showed itself in March',
      'Once upon a time, the tremor showed itself in March',
    );
    const check = checkHistoricalFictionStory(cliched);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/no-cliche-opening/);
  });

  it('stripping the dialogue fails the dialogue gate', () => {
    const noDialogue = REFERENCE_STORY.replace(/["“][^"“”\n]{2,}["”]/g, 'something unsaid');
    const check = checkHistoricalFictionStory(noDialogue);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('dialogue');
  });

  it('a synopsis-length draft fails the length gate with the fix named', () => {
    const synopsis = REFERENCE_STORY.slice(0, 1800);
    const check = checkHistoricalFictionStory(synopsis);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/story-length/);
  });

  it('a missing title heading fails the title gate', () => {
    const untitled = REFERENCE_STORY.replace('# The Blackbird Under the Dial\n\n', '');
    const check = checkHistoricalFictionStory(untitled);
    expect(check.ok).toBe(false);
    expect(check.missingRequiredSignals).toContain('title');
  });
});
