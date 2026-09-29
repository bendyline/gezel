/**
 * Retrieval-bench entity families. Every family is fictional, so no model
 * can answer from memory and no embedder has seen the entity; what a surface
 * keeps is decided by the corpus alone.
 *
 * Each family carries the same eight document roles, so every query class
 * meets the same kinds of competition:
 *
 *   golden        — the article the question is about (grade 2)
 *   counterpart   — the team's own note on it, in the shared library or the
 *                   project workspace (grade 2; multi-corpus competition)
 *   background    — the general topic, no entity (grade 1)
 *   nearMiss      — same topic, different entity (grade 1)
 *   narrow        — same entity, a narrow side story (grade 1) — the
 *                   "Coronation quiche" shape
 *   lexicalDecoy  — shares only a name or a filler word (grade 0)
 *   lookalike     — an orthographic neighbour in another field (grade 0) —
 *                   the "QuEChERS for quiche" shape
 *   boilerplate   — matches craftbook step prose, not any subject (grade 0)
 *                   — the "Top Deck (drink)" / "Priority review" shape
 *
 * Families 1–8 are the DEV split; 1–4 carry the four real incident decoys we
 * already tuned against, so they are regression checks, not evidence of
 * generalization. Families 9–12 are the TEST split: authored separately, with
 * the same decoy categories but new examples, and scored once per lever
 * decision. See LABELS.md.
 */

export type CorpusSurface = 'knowledge' | 'shared' | 'workspace';
export type FamilySplit = 'dev' | 'test';

export interface CorpusDoc {
  title: string;
  body: string;
}

export interface Family {
  id: string;
  split: FamilySplit;
  domain: string;
  golden: CorpusDoc;
  counterpart: CorpusDoc & { surface: 'shared' | 'workspace'; path: string };
  background: CorpusDoc;
  nearMiss: CorpusDoc;
  narrow: CorpusDoc;
  lexicalDecoy: CorpusDoc;
  lookalike: CorpusDoc;
  boilerplate: CorpusDoc;
  queries: {
    /** Names the entity and topic. */
    title: string;
    /** Same intent, no title words. */
    paraphrase: string;
    /** A launch request, book words included. */
    launch: string;
    /** A person asking in chat. */
    direct: string;
    /** Same domain, an entity the corpus does not have. Expect abstention. */
    absent: string;
    /** The entity, but a topic only grade-1 documents touch. Abstain or grade 1. */
    nearMissOnly: string;
    /** The team's own note is the best answer; the article is background. */
    multiCorpus: string;
  };
}

export const FAMILIES: readonly Family[] = [
  {
    id: 'rasmund-pilot',
    split: 'dev',
    domain: 'ports',
    golden: {
      title: 'Rasmund Terminal winter boarding pilot',
      body: 'The Rasmund Terminal winter boarding pilot ran from November 2024 to March 2025 on the Brask ferry route. Heated boarding bridges replaced open gangways, cutting average boarding time from 14 to 9 minutes. The pilot recorded 212,000 passenger boardings and 3 slip incidents, down from 27 the previous winter. Harbour authority engineer Ilse Varga led the trial, which cost 4.8 million krona.',
    },
    counterpart: {
      surface: 'shared',
      path: 'policies/rasmund-pilot-rollout.md',
      title: 'Rasmund pilot rollout policy',
      body: 'Internal policy for rolling out the Rasmund winter boarding changes to our other terminals. Heated bridges go first to terminals with more than 500 winter boardings a day. Each rollout needs an ops lead sign-off and a two-week shadow period with the old gangway kept on standby.',
    },
    background: {
      title: 'Ferry terminal boarding operations',
      body: 'Ferry terminals move passengers between shore and vessel through gangways, boarding bridges, or ramps. Weather, tide, and vessel height drive the choice of equipment and the time a boarding takes.',
    },
    nearMiss: {
      title: 'Orsby Terminal summer boarding pilot',
      body: 'The Orsby Terminal summer boarding pilot tested timed boarding windows on the Ostry route in June 2023. Queues shortened, but the route saw no change in on-time departures.',
    },
    narrow: {
      title: 'Rasmund Terminal ribbon-cutting ceremony',
      body: 'The Rasmund Terminal opened in 1998 with a ribbon-cutting ceremony attended by the regional governor. A brass band played on the quay and the first ferry left twenty minutes late.',
    },
    lexicalDecoy: {
      title: 'Rasmund Brewing Company',
      body: 'Rasmund Brewing Company is a small brewery known for a dark winter ale. Its taproom sits two streets from the old harbour and hosts a quiz night on Thursdays.',
    },
    lookalike: {
      title: 'Rasmundite',
      body: 'Rasmundite is a rare copper sulfate mineral first described from a mine in the northern highlands. It forms blue crusts on weathered ore and is of interest mainly to collectors.',
    },
    boilerplate: {
      title: 'Upper deck seating rules',
      body: 'Upper deck seating on passenger ferries follows an outline set by the operator: one message per deck, evidence of capacity checks, and a numbered sequence for boarding the deck in bad weather.',
    },
    queries: {
      title: 'Rasmund Terminal winter boarding pilot',
      paraphrase: 'how did the northern ferry dock test loading passengers in freezing weather',
      launch:
        'Can you create a PowerPoint about the Rasmund Terminal winter boarding pilot for our ops leads?',
      direct: 'What did the Rasmund winter boarding pilot change for passengers?',
      absent: 'Morrow Terminal night freight trial results',
      nearMissOnly: 'What is the Rasmund Terminal summer timetable?',
      multiCorpus: 'What is our internal policy for rolling out the Rasmund boarding changes?',
    },
  },
  {
    id: 'brenzel-tart',
    split: 'dev',
    domain: 'food',
    golden: {
      title: 'Brenzel tart',
      body: 'A Brenzel tart is a savoury custard tart from the Ostmark hill country. The shortcrust case is blind-baked, then filled with eggs, soured cream, smoked leeks, and a hard sheep cheese called vessel. It is baked low and slow and served warm in wedges. Ostmark cooks argue over whether bacon belongs in it; the oldest recipes leave it out.',
    },
    counterpart: {
      surface: 'workspace',
      path: 'recipes/brenzel-notes.md',
      title: 'brenzel-notes.md',
      body: 'Our test-kitchen notes on the Brenzel tart: blind-bake 18 minutes, custard ratio three eggs to 250 ml soured cream, bake at 160 °C for 40 minutes. Guests preferred it without bacon.',
    },
    background: {
      title: 'Savoury custard tarts',
      body: 'Savoury custard tarts set eggs and dairy around vegetables, cheese, or meat in a pastry case. They are baked gently so the custard sets without curdling.',
    },
    nearMiss: {
      title: 'Harrow pie',
      body: 'Harrow pie is a covered game pie from the lowland coast, filled with rabbit and root vegetables under a hot-water crust.',
    },
    narrow: {
      title: 'Jubilee Brenzel tart',
      body: 'The Jubilee Brenzel tart was a one-off variation created for a regional jubilee in 2019, topped with pickled beetroot. It was served at a single banquet and never caught on.',
    },
    lexicalDecoy: {
      title: 'Brenzel Street',
      body: 'Brenzel Street is a shopping street in the old town of Ostmark, lined with bakeries and a covered market.',
    },
    lookalike: {
      title: 'BRENSEL assay',
      body: 'The BRENSEL assay is a laboratory sample-preparation method for detecting pesticide residues in produce. It uses salting-out extraction followed by dispersive cleanup.',
    },
    boilerplate: {
      title: 'Top Deck (Ostmark soda)',
      body: 'Top Deck is a lemon soda sold in Ostmark since the 1970s, advertised with a deck of playing cards and the slogan "one message per bottle".',
    },
    queries: {
      title: 'Brenzel tart',
      paraphrase: 'the savoury egg and leek pie from the Ostmark hills',
      launch: 'Can you create a PowerPoint about Brenzel tart?',
      direct: 'Does a traditional Brenzel tart have bacon in it?',
      absent: 'Velmoor dumplings recipe',
      nearMissOnly: 'What drinks are served with Brenzel tart?',
      multiCorpus: 'What oven temperature did we settle on for our Brenzel tart?',
    },
  },
  {
    id: 'corvel-festival',
    split: 'dev',
    domain: 'culture',
    golden: {
      title: 'Corvel Lantern Festival',
      body: 'The Corvel Lantern Festival is held on the first new moon of autumn in the river town of Corvel. Residents float about 4,000 paper lanterns down the Tessa river to mark the end of harvest. The festival began in 1872 after a flood spared the town, and the lanterns were first lit to thank the river. It now draws around 30,000 visitors a year.',
    },
    counterpart: {
      surface: 'shared',
      path: 'events/corvel-festival-trip.md',
      title: 'corvel-festival-trip.md',
      body: 'Our team trip plan for the Corvel Lantern Festival: book the river-view hall by June, 30 lanterns per team, and a safety brief about the riverbank at dusk.',
    },
    background: {
      title: 'Lantern festivals',
      body: 'Lantern festivals light paper or silk lanterns to mark a season, a harvest, or a remembrance. Many float lanterns on water; others hang them in streets.',
    },
    nearMiss: {
      title: 'Ashby Kite Festival',
      body: 'The Ashby Kite Festival fills the coastal meadows with kites every spring. It began as a school contest in 1961.',
    },
    narrow: {
      title: 'Corvel Lantern Festival stamp',
      body: 'In 1997 the national post office issued a stamp showing a single lantern on the Tessa river to mark the festival’s 125th year.',
    },
    lexicalDecoy: {
      title: 'All About Making Things',
      body: 'All About Making Things was a weekly craft column about how to create simple household objects, from paper boxes to wooden spoons.',
    },
    lookalike: {
      title: 'Corvell valve',
      body: 'The Corvell valve is a pressure-relief valve used in industrial steam lines, named after its designer.',
    },
    boilerplate: {
      title: 'Outline of festival planning',
      body: 'An outline of festival planning: audience, sequence, evidence of permits, and one message per announcement slide.',
    },
    queries: {
      title: 'Corvel Lantern Festival',
      paraphrase: 'the autumn river celebration where a town floats thousands of paper lights',
      launch: 'Can you create a presentation about the Corvel Lantern Festival?',
      direct: 'Why do people in Corvel float lanterns on the river?',
      absent: 'Dunmere midsummer bonfire history',
      nearMissOnly: 'What food stalls are at the Corvel Lantern Festival?',
      multiCorpus: 'How many lanterns does each team get on our Corvel festival trip?',
    },
  },
  {
    id: 'veltor-accreditation',
    split: 'dev',
    domain: 'regulation',
    golden: {
      title: 'Veltor Agency clinic accreditation scheme',
      body: 'The Veltor Agency clinic accreditation scheme certifies outpatient clinics against 42 standards covering infection control, records, and staffing. Clinics are audited every three years; a failed audit triggers a re-inspection within 90 days. By 2025, 1,340 clinics held accreditation. The scheme replaced a voluntary registry in 2016.',
    },
    counterpart: {
      surface: 'workspace',
      path: 'compliance/veltor-audit-checklist.md',
      title: 'veltor-audit-checklist.md',
      body: 'Our checklist for the next Veltor accreditation audit: records retention evidence, infection-control logs for the last 12 months, and the staffing roster signed by the clinic manager.',
    },
    background: {
      title: 'Clinic accreditation',
      body: 'Clinic accreditation schemes certify that healthcare providers meet published standards, usually through periodic audits by an independent body.',
    },
    nearMiss: {
      title: 'Marrin Board laboratory licensing',
      body: 'The Marrin Board licenses diagnostic laboratories and inspects them every two years.',
    },
    narrow: {
      title: 'Veltor Agency headquarters building',
      body: 'The Veltor Agency moved into a converted textile mill in 2011. The building won a regional award for its reuse of the original brick vaults.',
    },
    lexicalDecoy: {
      title: 'Veltor (surname)',
      body: 'Veltor is a family name found mostly in the eastern provinces, first recorded in parish rolls in the 1600s.',
    },
    lookalike: {
      title: 'Veltorite pigment',
      body: 'Veltorite is a green iron pigment once used in fresco painting.',
    },
    boilerplate: {
      title: 'Priority review',
      body: 'Priority review is the Veltor fast-track for novel devices: the review step is shortened and the review evidence is checked before conversion to full approval.',
    },
    queries: {
      title: 'Veltor Agency clinic accreditation scheme',
      paraphrase:
        'how outpatient clinics get certified against the national standards and how often they are audited',
      launch: 'Can you create a PowerPoint about the Veltor clinic accreditation scheme?',
      direct: 'How often does Veltor audit an accredited clinic?',
      absent: 'Oster Council pharmacy licensing fees',
      nearMissOnly: 'Who runs the Veltor Agency today?',
      multiCorpus: 'What do we need to prepare for our next Veltor audit?',
    },
  },
  {
    id: 'tessaline-barrier',
    split: 'dev',
    domain: 'engineering',
    golden: {
      title: 'Tessaline flood barrier',
      body: 'The Tessaline flood barrier is a set of seven rising sector gates across the Tessa estuary, completed in 2009. Each gate weighs 1,100 tonnes and closes in 25 minutes. The barrier has closed 41 times, most recently during the storm surge of January 2024. It protects roughly 180,000 homes upstream.',
    },
    counterpart: {
      surface: 'shared',
      path: 'reports/tessaline-site-visit.md',
      title: 'tessaline-site-visit.md',
      body: 'Notes from our site visit to the Tessaline barrier: the control room runs closure drills monthly, and the gate seals are replaced on a ten-year cycle.',
    },
    background: {
      title: 'Storm surge barriers',
      body: 'Storm surge barriers close river mouths or estuaries against tidal surges, using gates that stay open in normal conditions.',
    },
    nearMiss: {
      title: 'Orrin Dam',
      body: 'The Orrin Dam is an earth-fill dam built for irrigation and hydropower in 1968.',
    },
    narrow: {
      title: 'Tessaline barrier visitor centre',
      body: 'The Tessaline barrier visitor centre opened in 2012 with a café and a model of the gates.',
    },
    lexicalDecoy: {
      title: 'Tessaline (ship)',
      body: 'Tessaline was a cargo schooner lost off the northern cape in 1891.',
    },
    lookalike: {
      title: 'Tesselin polymer',
      body: 'Tesselin is a heat-resistant polymer used in cookware coatings.',
    },
    boilerplate: {
      title: 'Evaluation of saved decks',
      body: 'A guide to the evaluation of saved presentation decks: file integrity, one message per slide, and the review limits of previews.',
    },
    queries: {
      title: 'Tessaline flood barrier',
      paraphrase: 'the estuary gates that close against storm surges to protect the city upstream',
      launch: 'Can you create a PowerPoint about the Tessaline flood barrier?',
      direct: 'How long does the Tessaline barrier take to close?',
      absent: 'Harwick sea wall collapse inquiry',
      nearMissOnly: 'What does the Tessaline visitor café serve?',
      multiCorpus: 'What did we learn on our Tessaline site visit?',
    },
  },
  {
    id: 'quorra-sync',
    split: 'dev',
    domain: 'software',
    golden: {
      title: 'Quorra sync protocol',
      body: 'Quorra is an offline-first sync protocol for document databases. Clients keep an operation log and exchange compressed deltas when they reconnect; conflicts resolve with per-field last-writer-wins stamped by hybrid logical clocks. Version 2 added end-to-end encryption of deltas. Quorra servers never read document contents.',
    },
    counterpart: {
      surface: 'workspace',
      path: 'docs/quorra-integration.md',
      title: 'quorra-integration.md',
      body: 'How our app integrates Quorra: we sync every 30 seconds when online, keep 500 operations of log per device, and show a conflict badge when last-writer-wins drops a local edit.',
    },
    background: {
      title: 'Offline-first synchronization',
      body: 'Offline-first apps store data locally and synchronize with a server when a connection is available, resolving conflicting edits by a merge rule.',
    },
    nearMiss: {
      title: 'Tidewire replication',
      body: 'Tidewire is a server-to-server database replication system using a single leader.',
    },
    narrow: {
      title: 'Quorra logo controversy',
      body: 'In 2021 the Quorra project changed its logo after a trademark complaint from a furniture maker.',
    },
    lexicalDecoy: {
      title: 'Quorra (film character)',
      body: 'Quorra is a character in a science-fiction film, a program living inside a computer world.',
    },
    lookalike: {
      title: 'Quora',
      body: 'Quora is a question-and-answer website where users post and answer questions.',
    },
    boilerplate: {
      title: 'Publish and convert checklist',
      body: 'A publish checklist: convert the approved source, inspect and preview it, and save the binary deliverables with review evidence.',
    },
    queries: {
      title: 'Quorra sync protocol',
      paraphrase: 'how clients merge edits made while offline when they reconnect',
      launch: 'Can you create a PowerPoint about the Quorra sync protocol for new engineers?',
      direct: 'How does Quorra resolve conflicting edits?',
      absent: 'Brightloom message queue retention settings',
      nearMissOnly: 'Who maintains the Quorra project?',
      multiCorpus: 'How often does our app sync with Quorra?',
    },
  },
  {
    id: 'ardenmoor-treaty',
    split: 'dev',
    domain: 'history',
    golden: {
      title: 'Treaty of Ardenmoor',
      body: 'The Treaty of Ardenmoor, signed in 1644, ended the eleven-year Border War between the duchies of Lenn and Varrow. Lenn ceded the salt marshes south of the Arden river, and both sides agreed to a shared toll on river traffic. The treaty is remembered for its clause guaranteeing fishermen free passage in wartime.',
    },
    counterpart: {
      surface: 'shared',
      path: 'curriculum/ardenmoor-lesson.md',
      title: 'ardenmoor-lesson.md',
      body: 'Our lesson plan on the Treaty of Ardenmoor for year nine: a map activity on the ceded marshes and a debate on the fishermen’s clause.',
    },
    background: {
      title: 'Early modern peace treaties',
      body: 'Early modern peace treaties settled borders, tolls, and succession after wars between European states.',
    },
    nearMiss: {
      title: 'Treaty of Holloway',
      body: 'The Treaty of Holloway (1702) settled a dispute over mountain passes between two alpine cantons.',
    },
    narrow: {
      title: 'Ardenmoor treaty table',
      body: 'The oak table on which the Treaty of Ardenmoor was signed is kept in the Lenn town hall and was restored in 1988.',
    },
    lexicalDecoy: {
      title: 'Ardenmoor Golf Club',
      body: 'Ardenmoor Golf Club is an 18-hole course laid out in 1925 on former heathland.',
    },
    lookalike: {
      title: 'Ardennite',
      body: 'Ardennite is a manganese silicate mineral found in metamorphic rocks.',
    },
    boilerplate: {
      title: 'Acquire and verify sources',
      body: 'A research guide: acquire and verify sources, read the exact supplied source, and prefer authoritative research before outlining.',
    },
    queries: {
      title: 'Treaty of Ardenmoor',
      paraphrase: 'the 1600s peace deal that ended the border war and protected fishermen',
      launch: 'Can you create a PowerPoint about the Treaty of Ardenmoor?',
      direct: 'What did Lenn give up in the Treaty of Ardenmoor?',
      absent: 'Siege of Castle Wenn casualties',
      nearMissOnly: 'Who drafted the Treaty of Ardenmoor?',
      multiCorpus: 'What activities are in our Ardenmoor lesson plan?',
    },
  },
  {
    id: 'lysker-comet',
    split: 'dev',
    domain: 'science',
    golden: {
      title: 'Lysker comet flyby',
      body: 'Comet Lysker passed within 0.31 astronomical units of the Sun in April 2023. The Brenna probe flew through its tail and measured water ice making up 38 percent of the dust. The comet has an orbital period of 71 years and will return in 2094.',
    },
    counterpart: {
      surface: 'workspace',
      path: 'outreach/lysker-talk.md',
      title: 'lysker-talk.md',
      body: 'Speaker notes for our public talk on the Lysker flyby: start with the probe’s tail crossing, then the 38 percent water-ice result.',
    },
    background: {
      title: 'Comet tails',
      body: 'Comets grow tails of dust and ionized gas as sunlight heats their icy nuclei near perihelion.',
    },
    nearMiss: {
      title: 'Comet Osk',
      body: 'Comet Osk is a short-period comet that broke into three pieces in 2017.',
    },
    narrow: {
      title: 'Lysker (amateur astronomer)',
      body: 'Annika Lysker, the amateur astronomer who discovered the comet, ran a bakery by day.',
    },
    lexicalDecoy: {
      title: 'Lysker FC',
      body: 'Lysker FC is a semi-professional football club from the northern coast.',
    },
    lookalike: {
      title: 'Lysine',
      body: 'Lysine is an essential amino acid found in meat, eggs, and legumes.',
    },
    boilerplate: {
      title: 'Write the Markdown deck',
      body: 'Guidance to write the Markdown deck with exactly one matching heading per locked outline slide.',
    },
    queries: {
      title: 'Lysker comet flyby',
      paraphrase: 'the probe that flew through a comet tail and found lots of water ice',
      launch: 'Can you create a PowerPoint about the Lysker comet flyby?',
      direct: 'When will comet Lysker return?',
      absent: 'Varn asteroid mining survey',
      nearMissOnly: 'How bright was comet Lysker at its peak?',
      multiCorpus: 'How should our Lysker talk open?',
    },
  },
  {
    id: 'maridel-frost-fans',
    split: 'test',
    domain: 'agriculture',
    golden: {
      title: 'Maridel orchard frost fans',
      body: 'The Maridel cooperative installed 64 wind machines across its apple orchards in 2022 to fight spring frost. The fans pull warmer air down from a temperature inversion, raising blossom-level temperatures by 1.5 to 3 °C. In the April 2023 frost the cooperative lost 8 percent of its crop, against 45 percent in unprotected orchards nearby.',
    },
    counterpart: {
      surface: 'shared',
      path: 'grants/maridel-frost-grant.md',
      title: 'maridel-frost-grant.md',
      body: 'Our grant application notes for copying the Maridel frost fans: 12 machines for the east block, noise permit needed from the county.',
    },
    background: {
      title: 'Frost protection in orchards',
      body: 'Orchard growers protect blossoms from spring frost with wind machines, heaters, or overhead sprinklers.',
    },
    nearMiss: {
      title: 'Selby vineyard hail nets',
      body: 'The Selby vineyards cover their vines with hail nets from May to harvest.',
    },
    narrow: {
      title: 'Maridel apple fair',
      body: 'The Maridel apple fair crowns a harvest queen each October.',
    },
    lexicalDecoy: {
      title: 'Maridel (novel)',
      body: 'Maridel is a 1954 novel about a lighthouse keeper’s daughter.',
    },
    lookalike: {
      title: 'Marinol',
      body: 'Marinol is a brand-name prescription drug used to treat nausea.',
    },
    boilerplate: {
      title: 'Lock the outline',
      body: 'A planning note: lock the outline before drafting, with one message per section and numbered evidence.',
    },
    queries: {
      title: 'Maridel orchard frost fans',
      paraphrase: 'the big fans an apple cooperative put up to stop blossoms freezing',
      launch: 'Can you create a PowerPoint about the Maridel frost fans?',
      direct: 'How much of its crop did Maridel lose in the 2023 frost?',
      absent: 'Tovey greenhouse heating costs',
      nearMissOnly: 'What apple varieties does Maridel grow?',
      multiCorpus: 'How many frost machines are in our grant application?',
    },
  },
  {
    id: 'oskel-night-trams',
    split: 'test',
    domain: 'transport',
    golden: {
      title: 'Oskel night tram service',
      body: 'Oskel began running night trams on its two main lines in September 2024, every 20 minutes between 00:30 and 05:00 on Fridays and Saturdays. Ridership averaged 3,900 trips a night in the first six months, and late-night taxi complaints fell by a third. The service costs the city 2.1 million a year.',
    },
    counterpart: {
      surface: 'workspace',
      path: 'planning/oskel-night-service-review.md',
      title: 'oskel-night-service-review.md',
      body: 'Our review of the Oskel night trams for the council: extend to Thursdays if ridership stays above 3,500 trips a night.',
    },
    background: {
      title: 'Night public transport',
      body: 'Cities run night buses and trams to serve shift workers and late-evening travel after regular service ends.',
    },
    nearMiss: {
      title: 'Brindle night bus network',
      body: 'Brindle runs twelve night bus routes radiating from its central station.',
    },
    narrow: {
      title: 'Oskel tram museum',
      body: 'The Oskel tram museum keeps six historic cars in a former depot.',
    },
    lexicalDecoy: {
      title: 'Night (painting)',
      body: 'Night is an oil painting of a moonlit harbour, now in a private collection.',
    },
    lookalike: {
      title: 'Oskil river',
      body: 'The Oskil is a river that rises in the central uplands and flows south.',
    },
    boilerplate: {
      title: 'Review narrative and grounding',
      body: 'A reviewer’s guide to narrative and grounding: verify slide parity, factual traceability, and readiness before conversion.',
    },
    queries: {
      title: 'Oskel night tram service',
      paraphrase: 'late weekend trams that run after midnight in the city',
      launch: 'Can you create a PowerPoint about the Oskel night trams?',
      direct: 'How often do the Oskel night trams run?',
      absent: 'Wexby ferry night crossings',
      nearMissOnly: 'How much does an Oskel night tram ticket cost?',
      multiCorpus: 'When would we extend the night trams to Thursdays?',
    },
  },
  {
    id: 'venhold-choir',
    split: 'test',
    domain: 'music',
    golden: {
      title: 'Venhold Choir Competition',
      body: 'The Venhold Choir Competition is held every two years in the cathedral town of Venhold. Choirs sing one set piece and one free piece before a jury of five. The 2024 edition had 38 choirs from 11 countries; the grand prize went to a youth choir from the coastal town of Irren.',
    },
    counterpart: {
      surface: 'shared',
      path: 'choir/venhold-entry.md',
      title: 'venhold-entry.md',
      body: 'Our choir’s entry plan for Venhold: set piece rehearsals start in January, and the free piece is the folk arrangement.',
    },
    background: {
      title: 'Choral competitions',
      body: 'Choral competitions judge choirs on intonation, blend, and interpretation, often with a compulsory set piece.',
    },
    nearMiss: {
      title: 'Lorne Brass Band Contest',
      body: 'The Lorne Brass Band Contest has been held annually since 1920.',
    },
    narrow: {
      title: 'Venhold cathedral organ',
      body: 'The Venhold cathedral organ was rebuilt in 1976 with 4,200 pipes.',
    },
    lexicalDecoy: {
      title: 'Competition law',
      body: 'Competition law regulates anti-competitive conduct by companies, such as cartels and abuse of dominance.',
    },
    lookalike: {
      title: 'Venhol',
      body: 'Venhol is a brand of veterinary disinfectant.',
    },
    boilerplate: {
      title: 'Finish and deliver',
      body: 'Finish: deliver the saved files with the recorded review evidence and limits.',
    },
    queries: {
      title: 'Venhold Choir Competition',
      paraphrase: 'the international singing contest held in a cathedral town every other year',
      launch: 'Can you create a PowerPoint about the Venhold Choir Competition?',
      direct: 'Who won the 2024 Venhold choir competition?',
      absent: 'Marrow folk dance festival rules',
      nearMissOnly: 'Who sits on the Venhold jury?',
      multiCorpus: 'Which free piece are we singing at Venhold?',
    },
  },
  {
    id: 'pellarin-triage',
    split: 'test',
    domain: 'health',
    golden: {
      title: 'Pellarin clinic walk-in triage',
      body: 'Pellarin Health introduced nurse-led walk-in triage at its four clinics in 2023. A nurse sees every walk-in patient within 15 minutes and routes them to a doctor, a pharmacist, or self-care advice. Median waits for a doctor fell from 94 to 51 minutes, and 22 percent of walk-ins were resolved without a doctor visit.',
    },
    counterpart: {
      surface: 'workspace',
      path: 'ops/pellarin-triage-script.md',
      title: 'pellarin-triage-script.md',
      body: 'Our adapted triage script based on Pellarin: nurse sees walk-ins within 15 minutes; pharmacist route for minor infections.',
    },
    background: {
      title: 'Triage',
      body: 'Triage sorts patients by urgency so the sickest are seen first.',
    },
    nearMiss: {
      title: 'Harlow hospital virtual ward',
      body: 'Harlow hospital monitors recovering patients at home through a virtual ward.',
    },
    narrow: {
      title: 'Pellarin Health founder',
      body: 'Pellarin Health was founded by two sisters who were both district nurses.',
    },
    lexicalDecoy: {
      title: 'Walk-in closet',
      body: 'A walk-in closet is a storage room large enough to walk into, usually off a bedroom.',
    },
    lookalike: {
      title: 'Pellagra',
      body: 'Pellagra is a disease caused by a lack of niacin in the diet.',
    },
    boilerplate: {
      title: 'Evidence and gate checklist',
      body: 'A gate checklist: verify the criteria against the deliverable and the notes before advancing a step.',
    },
    queries: {
      title: 'Pellarin clinic walk-in triage',
      paraphrase: 'nurses sorting drop-in patients so fewer need to see a doctor',
      launch: 'Can you create a PowerPoint about Pellarin walk-in triage?',
      direct: 'How much did Pellarin’s triage cut doctor waits?',
      absent: 'Dunholm dental emergency rota',
      nearMissOnly: 'What are the Pellarin clinics’ opening hours?',
      multiCorpus: 'Which route does our triage script use for minor infections?',
    },
  },
];

/**
 * Step prose from craftbook-shaped tasks that name no subject — the query a
 * step with no main parameter builds from its own procedure. Every one should
 * make a surface abstain; the boilerplate decoys above are built to match
 * them lexically.
 */
export const STEP_PROSE_QUERIES: readonly { id: string; split: FamilySplit; text: string }[] = [
  {
    id: 'outline',
    split: 'dev',
    text: 'Lock the slide outline: audience, sequence, evidence, and one message per deck slide.',
  },
  {
    id: 'review',
    split: 'dev',
    text: 'Review narrative and grounding. Verify slide parity, factual traceability, and presentation readiness before conversion.',
  },
  {
    id: 'publish',
    split: 'dev',
    text: 'Publish the PowerPoint: convert the approved source, inspect and preview it, and save the binary deliverables with review evidence.',
  },
  {
    id: 'evaluate',
    split: 'dev',
    text: 'Evaluate the saved deck. Review saved-file integrity and content fidelity; document the limits of previews.',
  },
  {
    id: 'research',
    split: 'test',
    text: 'Acquire and verify sources. Read the exact supplied source and strongly prefer authoritative research before outlining.',
  },
  {
    id: 'write',
    split: 'test',
    text: 'Write the Markdown deck with exactly one matching H1 per locked outline slide.',
  },
];
