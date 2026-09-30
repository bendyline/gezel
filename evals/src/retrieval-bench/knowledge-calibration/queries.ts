/**
 * Labelled queries for calibrating knowledge-catalog injection against REAL
 * installed catalogs — the Handboek (bundled) and Wikipedia Food & Drink.
 * The retrieval bench's synthetic corpus cannot measure an embedder's scale
 * on real prose, and knowledge floors are a property of the catalog as much
 * as the embedder.
 *
 * Classes: `handboek` and `food` name the answer documents (grade 2) and a
 * few related ones (grade 1); `abstain` should inject nothing; `either` is a
 * task request whose same-named craftbook page is neither clearly wanted nor
 * clearly noise, so it counts toward neither false injection nor recall.
 *
 * Answers were picked by hand from the catalogs' document lists and hold for
 * the pinned versions below; a catalog rebuild can renumber or retitle them.
 */

export const KNOWLEDGE_CALIBRATION_CATALOGS = {
  handboek: { key: 'bendyline/handboek', version: '1.1.2' },
  food: { key: 'bendyline/wikipedia-food-drink', version: '2026.4.3' },
} as const;

export type KnowledgeQueryClass = 'handboek' | 'food' | 'abstain' | 'either';

export interface KnowledgeCalibrationQuery {
  id: string;
  class: KnowledgeQueryClass;
  text: string;
  /** Grade-2 docKeys (`knowledge://publisher/catalog/docId`). */
  answers: readonly string[];
  /** Grade-1 docKeys. */
  related: readonly string[];
}

const hb = (doc: string) => `knowledge://bendyline/handboek/${doc}`;
const food = (doc: string) => `knowledge://bendyline/wikipedia-food-drink/${doc}`;

function q(
  id: string,
  cls: KnowledgeQueryClass,
  text: string,
  answers: string[] = [],
  related: string[] = [],
): KnowledgeCalibrationQuery {
  return { id, class: cls, text, answers, related };
}

export const KNOWLEDGE_CALIBRATION_QUERIES: readonly KnowledgeCalibrationQuery[] = [
  q(
    'h01',
    'handboek',
    'What is a craftbook and how do I start one?',
    [hb('craftbooks-overview')],
    [hb('craftbooks-index')],
  ),
  q(
    'h02',
    'handboek',
    'Where does Gezel store my data?',
    [hb('privacy-local-first'), hb('where-files-live')],
    [hb('memory-and-documents')],
  ),
  q('h03', 'handboek', 'How do I verify that my Gezel download is authentic?', [
    hb('verifying-your-download'),
  ]),
  q('h04', 'handboek', 'What does the Meester do?', [hb('the-crew')], [hb('welcome')]),
  q(
    'h05',
    'handboek',
    'What happens during the night shift?',
    [hb('night-shift')],
    [hb('tasks-and-supervision')],
  ),
  q('h06', 'handboek', 'How does generalist mode work?', [hb('generalist-mode')]),
  q(
    'h07',
    'handboek',
    'Which AI models can run on this computer?',
    [hb('local-models-and-tiers')],
    [hb('model-scorecard'), hb('providers-and-engines')],
  ),
  q(
    'h08',
    'handboek',
    'How can another app on my computer use my gezels?',
    [hb('connected-apps')],
    [hb('building-connected-apps-with-gezel-app-sdk')],
  ),
  q('h09', 'handboek', 'What tools and toolsets can gezels use?', [hb('tools-and-toolsets')]),
  q(
    'h10',
    'handboek',
    'How does Gezel stop gezels from changing my files without permission?',
    [hb('security-model')],
    [hb('where-files-live')],
  ),
  q('h11', 'handboek', 'How do projects and threads work in Gezel?', [hb('projects-and-threads')]),
  q('h12', 'handboek', 'How do I use the gezel command line?', [hb('cli-reference')]),
  q('h13', 'handboek', 'How does Gezel test and score local models?', [
    hb('how-we-test-models'),
    hb('model-scorecard'),
  ]),
  q(
    'h14',
    'handboek',
    'Can I write scripts with the gezel SDK?',
    [hb('writing-scripts-with-gezel-sdk')],
    [hb('npm-packages')],
  ),
  q(
    'h15',
    'handboek',
    'How do scheduled tasks and supervision work in Gezel?',
    [hb('tasks-and-supervision')],
    [hb('night-shift')],
  ),
  q(
    'h16',
    'handboek',
    'What changed in the latest Gezel release?',
    [hb('whats-new-index'), hb('whats-new/1.26272')],
    [hb('whats-new/1.26261')],
  ),
  q(
    'h17',
    'handboek',
    'What is the difference between providers and engines in Gezel?',
    [hb('providers-and-engines')],
    [hb('local-models-and-tiers')],
  ),
  q('h18', 'handboek', 'How does Gezel remember things between chats?', [
    hb('memory-and-documents'),
  ]),
  q('h19', 'handboek', 'Which npm packages does Gezel publish?', [hb('npm-packages')]),
  q('h20', 'handboek', 'How do I build an AI App inside Gezel?', [
    hb('building-ai-apps-inside-gezel'),
  ]),

  q('f01', 'food', 'What is the difference between espresso and ristretto?', [
    food('555498'),
    food('47660'),
  ]),
  q('f02', 'food', 'How is sourdough bread leavened?', [food('189345')], [food('36969')]),
  q('f03', 'food', 'How is tofu made?', [food('22419013')]),
  q('f04', 'food', 'What is kimchi and how is it fermented?', [food('178952')]),
  q('f05', 'food', 'What goes on a pizza Margherita?', [food('2804244')]),
  q('f06', 'food', 'How is miso made?', [food('20889')]),
  q('f07', 'food', 'What is umami?', [food('62462')]),
  q('f08', 'food', 'How do you make a French omelette?', [food('167240')]),
  q('f09', 'food', 'What is the history of the croissant?', [food('164372')]),
  q('f10', 'food', 'How is maple syrup produced?', [food('19886')]),
  q('f11', 'food', 'What does baking powder do in a cake?', [food('193284')]),
  q('f12', 'food', 'What is paella and where does it come from?', [food('47630')]),
  q('f13', 'food', 'What is mezcal made from?', [food('81092')]),
  q('f14', 'food', 'What is a roux used for in cooking?', [food('289795')]),
  q('f15', 'food', 'What is the difference between sushi and sashimi?', [food('28271')]),
  q('f16', 'food', 'What are the main ingredients in hummus?', [food('75065')]),
  q('f17', 'food', 'How do you make guacamole?', [food('484865')]),
  q('f18', 'food', 'What is kombucha?', [food('264062')]),
  q('f19', 'food', 'How is gelato different from ice cream?', [food('483473'), food('48212')]),
  q('f20', 'food', 'What is in a tiramisu?', [food('30845')]),

  q('a01', 'abstain', 'What is 17 times 23?'),
  q('a02', 'abstain', 'Write a haiku about my cat sleeping in the sun'),
  q('a03', 'abstain', 'Summarize the history of the Roman empire in three sentences'),
  q('a04', 'abstain', 'Draft a polite email declining a meeting next Tuesday'),
  q('a05', 'abstain', 'What is a good name for a golden retriever puppy?'),
  q('a06', 'abstain', 'What causes the seasons on Earth?'),
  q('a07', 'abstain', 'Fix the grammar in this sentence: their going to the store tomorrow'),
  q('a08', 'abstain', 'Give me three ideas for a science fair project'),
  q('a09', 'abstain', 'How do I change a flat tire on a bicycle?'),
  q('a10', 'abstain', 'What year did the Berlin Wall fall?'),
  q('a11', 'abstain', 'Write a limerick about a programmer who never sleeps'),
  q('a12', 'abstain', 'How many planets are in the solar system?'),
  q('a13', 'abstain', "What's the capital of Australia?"),
  q('a14', 'abstain', 'Explain the difference between a virus and a bacterium'),
  q('a15', 'abstain', 'How do I say thank you in Japanese?'),
  q('a16', 'abstain', 'Recommend a good book about leadership'),
  q('a17', 'abstain', 'What does a mortgage broker do?'),
  q('a18', 'abstain', 'Convert 72 degrees Fahrenheit to Celsius'),
  q('a19', 'abstain', 'Tell me a joke about penguins'),
  q('a20', 'abstain', 'How do airplanes stay in the air?'),
  q('a21', 'abstain', 'Plan a weekend itinerary for Chicago'),
  q('a22', 'abstain', 'What is the tallest mountain in Europe?'),
  q('a23', 'abstain', 'Can you explain what a black hole is?'),
  q('a24', 'abstain', 'Write a short birthday message for my coworker Sam'),
  q('a25', 'abstain', 'How do I improve my posture at a desk?'),

  q('e01', 'either', 'Help me write a cover letter for a marketing manager job'),
  q('e02', 'either', 'Translate good morning into Spanish and French'),
  q('e03', 'either', 'Suggest a workout plan for beginners, three days a week'),
  q('e04', 'either', 'Can you help me plan a birthday dinner for six people on Saturday?'),
  q('e05', 'either', 'Explain how compound interest works'),
];
