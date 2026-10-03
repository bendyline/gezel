/**
 * The factuality bench's first topic: George Washington's family.
 *
 * Chosen because a person asked a writer gezel in Word for exactly this and
 * got several details wrong, and because it is the shape local models fail
 * worst on — a famous subject whose minor relatives (half-siblings, step-
 * grandchildren, in-laws) a model half-remembers and fills in fluently.
 *
 * `REFERENCE` is the answer key the judge grades against. Every line was
 * checked against the English Wikipedia articles named in `REFERENCE_SOURCES`
 * (2026-10-02). It is deliberately a key, not a corpus: the gezel under test
 * never sees it, and a claim the key does not cover is "unverified", not
 * wrong — the judge only counts contradictions as errors.
 */

export interface FactualityPrompt {
  id: string;
  /** What the person asks, phrased the way a document writer would. */
  prompt: string;
  /** Key facts a complete answer states; the judge reports which it got right. */
  expects: string[];
}

export const REFERENCE_SOURCES = [
  'George Washington',
  'Martha Washington',
  'Augustine Washington',
  'Mary Ball Washington',
  'Lawrence Washington (1718–1752)',
  'Betty Washington Lewis',
  'John Parke Custis',
  'George Washington Parke Custis',
  'Nelly Parke Custis Lewis',
  'Bushrod Washington',
  'Mount Vernon',
  'John Washington',
];

export const REFERENCE = `
George Washington was born February 22, 1732 (February 11, 1731, Old Style) at Popes Creek in Westmoreland County, Colony of Virginia. He died December 14, 1799, at Mount Vernon, aged 67.
His father was Augustine Washington (1694–1743), who died April 12, 1743, when George was 11. His mother was Mary Ball Washington (c. 1708 – August 25, 1789), Augustine's second wife.
Augustine's first wife was Jane Butler (died 1729). Their children, George's half-siblings: Butler (born 1716, died in infancy), Lawrence (1718–1752), Augustine Jr., called Austin (1720–1762), and Jane (1722–1735).
Mary Ball's children, George's full siblings: George (1732), Elizabeth "Betty" (1733–1797), Samuel (1734–1781), John Augustine (1736–1787), Charles (1738–1799), and Mildred (1739–1740).
Betty married Fielding Lewis; their son Lawrence Lewis married Nelly Parke Custis on February 22, 1799.
Lawrence Washington, George's older half-brother, served under Vice Admiral Edward Vernon and named his estate Mount Vernon after him. He married Anne Fairfax. He died of tuberculosis in 1752. George leased Mount Vernon from Anne Fairfax in 1754 and became its sole owner on her death in 1761.
George married Martha Dandridge Custis on January 6, 1759, at White House, her plantation in New Kent County, Virginia.
Martha Dandridge was born June 2, 1731, at Chestnut Grove plantation in New Kent County, and died May 22, 1802, at Mount Vernon.
Martha's first husband was Daniel Parke Custis (1711–1757); they married in 1750. They had four children: Daniel Parke Custis (1751–1754), Frances Parke Custis (1753–1757), John Parke "Jacky" Custis (1754–1781), and Martha Parke "Patsy" Custis (1756–1773).
George and Martha Washington had no children together. George raised Martha's two surviving children, Jacky and Patsy, as his stepchildren.
Patsy Custis suffered from epilepsy and died of a seizure on June 19, 1773, aged 17.
Jacky Custis married Eleanor Calvert in 1774. He served as a civilian aide to Washington at the siege of Yorktown and died of camp fever (likely typhus) on November 5, 1781.
Jacky's children, George's step-grandchildren: Elizabeth Parke Custis Law (1776–1831), Martha Parke Custis Peter (1777–1854), Eleanor "Nelly" Parke Custis Lewis (1779–1852), and George Washington Parke Custis (1781–1857). George and Martha raised the two youngest, Nelly and George Washington Parke Custis ("Washy"), at Mount Vernon.
George Washington Parke Custis built Arlington House. His daughter Mary Anna Randolph Custis married Robert E. Lee in 1831.
Bushrod Washington (1762–1829), son of George's brother John Augustine, was an Associate Justice of the Supreme Court from 1798 to 1829. He inherited Mount Vernon under George's will, taking possession after Martha's death in 1802.
George's great-grandfather John Washington emigrated from England to the Colony of Virginia in 1656.
Washington's will freed the people he enslaved after Martha's death, except William Lee, freed at once. Martha freed them on January 1, 1801. The enslaved people from the Custis estate (dower slaves) were not his to free and were not freed.
`.trim();

export const WASHINGTON_PROMPTS: FactualityPrompt[] = [
  {
    id: 'parents',
    prompt:
      "Write a short paragraph about George Washington's parents for a family history document.",
    expects: ['Augustine Washington', 'Mary Ball', 'Augustine died 1743', 'George was 11'],
  },
  {
    id: 'siblings',
    prompt: "List George Washington's full siblings and half-siblings with their birth years.",
    expects: [
      'Lawrence 1718',
      'Augustine Jr. 1720',
      'Betty 1733',
      'Samuel 1734',
      'John Augustine 1736',
      'Charles 1738',
      'Mildred 1739',
    ],
  },
  {
    id: 'children',
    prompt:
      'Did George and Martha Washington have children together? Answer in two or three sentences.',
    expects: ['no children together', 'raised her children from her first marriage'],
  },
  {
    id: 'martha-children',
    prompt: "Write a paragraph about Martha Washington's children from her first marriage.",
    expects: [
      'Daniel Parke Custis was the father',
      'four children',
      'two died young',
      'Jacky 1754–1781',
      'Patsy 1756–1773',
    ],
  },
  {
    id: 'step-grandchildren',
    prompt: "Who were George Washington's step-grandchildren, and which of them did he raise?",
    expects: [
      'Elizabeth',
      'Martha',
      'Nelly',
      'George Washington Parke Custis',
      'raised Nelly and Washy',
    ],
  },
  {
    id: 'family-tree',
    prompt:
      'Draft a bulleted family tree section for a document about George Washington: his parents, wife, stepchildren, and step-grandchildren.',
    expects: [
      'Augustine',
      'Mary Ball',
      'Martha Dandridge Custis',
      'Jacky',
      'Patsy',
      'four step-grandchildren',
    ],
  },
  {
    id: 'wedding',
    prompt: 'When and where did George Washington marry Martha Dandridge Custis?',
    expects: ['January 6, 1759', 'White House plantation', 'New Kent County'],
  },
  {
    id: 'mount-vernon',
    prompt: 'How did George Washington come to own Mount Vernon? Write a short paragraph.',
    expects: ['Lawrence', 'named after Admiral Vernon', 'leased 1754', 'owner 1761'],
  },
  {
    id: 'heir',
    prompt: "Who inherited Mount Vernon after George Washington's death?",
    expects: ['Bushrod Washington', 'nephew', 'after Martha died'],
  },
  {
    id: 'lawrence',
    prompt: 'Write a paragraph about Lawrence Washington and his influence on George.',
    expects: ['half-brother', 'Anne Fairfax', 'Edward Vernon', 'died 1752'],
  },
  {
    id: 'lee',
    prompt: "How is Robert E. Lee connected to George Washington's family?",
    expects: [
      'married Mary Anna Randolph Custis',
      'daughter of George Washington Parke Custis',
      '1831',
    ],
  },
  {
    id: 'patsy',
    prompt: 'What happened to Patsy Custis?',
    expects: ['epilepsy', 'died 1773', 'aged 17'],
  },
  {
    id: 'betty',
    prompt: "Write a paragraph about George Washington's sister Betty.",
    expects: ['born 1733', 'married Fielding Lewis', 'died 1797'],
  },
  {
    id: 'father-death',
    prompt: "When did George Washington's father die, and how old was George?",
    expects: ['1743', '11'],
  },
  {
    id: 'emigrant',
    prompt: 'Who was the first of the Washington family to come to Virginia, and when?',
    expects: ['John Washington', '1656', 'great-grandfather'],
  },
  {
    id: 'washy',
    prompt: 'Write a paragraph about George Washington Parke Custis.',
    expects: ['1781–1857', "Martha's grandson", 'raised at Mount Vernon', 'Arlington House'],
  },
  {
    id: 'will',
    prompt: "What did George Washington's will say about the people he enslaved?",
    expects: [
      "freed after Martha's death",
      'William Lee freed at once',
      'Martha freed them in 1801',
      'dower slaves not freed',
    ],
  },
  {
    id: 'martha-bio',
    prompt: 'Write a short biography of Martha Washington for a family history document.',
    expects: ['born 1731', 'Daniel Parke Custis', 'married George 1759', 'died 1802'],
  },
  {
    id: 'bushrod',
    prompt: 'Who was Bushrod Washington?',
    expects: ['nephew', 'son of John Augustine', 'Supreme Court', 'inherited Mount Vernon'],
  },
  {
    id: 'deaths',
    prompt: 'When did George and Martha Washington die?',
    expects: ['December 14, 1799', 'May 22, 1802'],
  },
];
