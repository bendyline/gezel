import { describe, expect, it } from 'vitest';

import {
  KNOWLEDGE_EFFECTIVENESS_TOPICS,
  checkKnowledgeEffectivenessReport,
  knowledgeEffectivenessKickoff,
  knowledgeResearchObserved,
  makeKnowledgeEffectivenessScenario,
  researchPrecededReport,
  wikipediaResearchObserved,
} from './knowledge-effectiveness.ts';

function reportFor(topic: (typeof KNOWLEDGE_EFFECTIVENESS_TOPICS)[number]): string {
  const sectionBodies: Record<string, string> = {
    'Executive summary':
      'This report synthesizes the requested mechanisms, practical consequences, and important uncertainties [1].',
    'What carbohydrates are':
      'Carbohydrates include sugars, starch, and dietary fiber. Not all carbohydrates are nutritionally uniform: quality matters, as does the food matrix [1].',
    'Digestion, absorption, and metabolism':
      'Amylase starts starch digestion; brush-border enzymes in the small intestine complete it. SGLT1 transports glucose and galactose while GLUT5 transports fructose. Glycolysis uses glucose, glycogen stores it, and insulin and glucagon regulate the transition [2].',
    'Roles in foods and cooking':
      'Starch gelatinization thickens sauces, fermentation changes dough, and Maillard browning changes flavor and color [3].',
    'Health evidence and controversies':
      'Glycemic index varies by context, portion, processing, and mixed meal. Dietary fiber fermentation supports the gut microbiome and produces short-chain fatty acids. Added and intrinsic sugars occur in different food matrices [4].',
    'Practical implications':
      'Diet quality depends on source, processing, portion, and the complete eating pattern.',
    'Evolution and acquisition of resistance':
      'Selection pressure acts on bacterial populations. Mutation and horizontal gene transfer can spread resistance genes. Bacteria become resistant, not the patient body [1].',
    'Molecular mechanisms':
      'Beta-lactamase causes enzymatic drug inactivation; target alteration changes binding. Efflux pumps and reduced permeability lower exposure, while biofilms add tolerance [2].',
    'Clinical and public-health consequences':
      'Resistance can cause treatment failure, higher mortality, and limited treatment options [3].',
    'Stewardship and prevention':
      'Culture-guided diagnostic stewardship, narrow-spectrum selection, dose optimization, duration review, infection prevention, vaccination, and surveillance are complementary [4].',
    'One Health perspective':
      'One Health connects human medicine with animal and livestock use and environmental pathways.',
    'Detection methods':
      'The transit method measures periodic dimming; transit depth constrains radius and repetition gives orbital period. Radial velocity uses the Doppler effect and normally yields a minimum mass. Direct imaging resolves light, while microlensing, astrometry, and timing detect other signatures [1].',
    'From signals to planet properties':
      'Combining mass and radius estimates density and composition. Transmission spectroscopy characterizes an atmosphere and its molecules [2].',
    'Selection effects and false positives':
      'Selection bias favors short-period, large, or massive planets. False positives such as blended eclipsing binaries require follow-up and validation [3].',
    'Atmospheres and habitability':
      'Transmission spectroscopy and emission spectroscopy probe atmospheric spectra. A habitable zone orbit does not prove inhabited life; a biosignature remains ambiguous [4].',
    'Future directions':
      'Longer baselines, precise astrometry, direct-imaging coronagraphs, and cross-method follow-up will broaden the census.',
    Limitations:
      'Wikipedia-style references summarize a changing literature, observational samples are incomplete, and mechanisms should not be turned into individualized advice.',
    Sources: [
      '- [1] Reference overview — https://en.wikipedia.org/wiki/Overview',
      '- [2] Mechanisms — https://en.wikipedia.org/wiki/Mechanism',
      '- [3] Evidence — https://en.wikipedia.org/wiki/Evidence',
      '- [4] Limitations — https://en.wikipedia.org/wiki/Limitations',
    ].join('\n'),
  };
  const body = topic.sections
    .map(
      (section) =>
        `## ${section}\n\n${sectionBodies[section] ?? 'Evidence and implications are synthesized here [1].'}`,
    )
    .join('\n\n');
  // The real task asks for long prose. Repeat a neutral, sourced synthesis
  // paragraph inside an existing section so this fixture reaches the same
  // word band without weakening the production gate.
  const filler = Array.from(
    { length: 45 },
    () =>
      'The interpretation depends on mechanism, measurement, context, and uncertainty; the cited sources should be read together rather than as isolated claims [1].',
  ).join(' ');
  return `# ${topic.title}\n\n${body.replace('\n\n## Limitations', `\n\n${filler}\n\n## Limitations`)}`;
}

describe('knowledge-effectiveness paired scenarios', () => {
  it('requires an observed Wikipedia tool rather than a citation-shaped URL', () => {
    expect(wikipediaResearchObserved(['search', 'read_document'])).toBe(false);
    expect(wikipediaResearchObserved(['wikipedia_search'])).toBe(true);
    expect(wikipediaResearchObserved(['wikipedia_read'])).toBe(true);
  });

  it('requires an observed catalog hit or tool-result source rather than a citation-shaped URI', () => {
    expect(knowledgeResearchObserved({ knowledgeHits: 0, knowledgeSourceCount: 0 })).toBe(false);
    expect(knowledgeResearchObserved({ knowledgeHits: 0, knowledgeSourceCount: 1 })).toBe(true);
    expect(knowledgeResearchObserved({ knowledgeHits: 1, knowledgeSourceCount: 0 })).toBe(true);
  });

  it('requires research to precede an accepted report write', () => {
    expect(researchPrecededReport('2026-10-04T01:00:00.000Z', '2026-10-04T01:01:00.000Z')).toBe(
      true,
    );
    expect(researchPrecededReport('2026-10-04T01:02:00.000Z', '2026-10-04T01:01:00.000Z')).toBe(
      false,
    );
    expect(researchPrecededReport(undefined, '2026-10-04T01:01:00.000Z')).toBe(false);
  });

  it.each(KNOWLEDGE_EFFECTIVENESS_TOPICS)(
    '$id reference report satisfies the shared gate',
    (topic) => {
      const result = checkKnowledgeEffectivenessReport(reportFor(topic), topic);
      expect(result.ok, result.failReason).toBe(true);
      expect(result.score).toBe(result.scoreMax);
    },
  );

  it('accepts ledger-style bracketed source entries and carbohydrate-first calibration wording', () => {
    const topic = KNOWLEDGE_EFFECTIVENESS_TOPICS.find(
      (candidate) => candidate.id === 'food-carbohydrates',
    )!;
    const report = reportFor(topic)
      .replace(
        'Not all carbohydrates are nutritionally uniform: quality matters, as does the food matrix [1].',
        'Carbohydrates are not a nutritionally uniform category; quality and food matrix matter [1].',
      )
      .replace(/^- \[(\d+)\]/gm, '[$1]');
    const result = checkKnowledgeEffectivenessReport(report, topic);
    expect(result.ok, result.failReason).toBe(true);
    expect(result.signals).toContain('carb-calibration');
    expect(result.signals).toContain('source-list');
  });

  it.each(KNOWLEDGE_EFFECTIVENESS_TOPICS)('$id rejects a thin uncited report', (topic) => {
    const result = checkKnowledgeEffectivenessReport(`# ${topic.title}\n\nToo short.`, topic);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('word-band');
    expect(result.missingRequiredSignals).toContain('source-list');
    expect(result.missingRequiredSignals).toContain('inline-citations');
  });

  it.each(KNOWLEDGE_EFFECTIVENESS_TOPICS)(
    '$id keeps control and treatment prompts identical',
    (topic) => {
      const control = makeKnowledgeEffectivenessScenario(topic.id, 'control');
      const treatment = makeKnowledgeEffectivenessScenario(topic.id, 'catalog');
      expect(control.prompt).toBe(treatment.prompt);
      expect(control.evidenceTexts).toEqual(treatment.evidenceTexts);
      expect(control.modelNetworkAccess).toBe('wikipedia');
      expect(treatment.modelNetworkAccess).toBe('wikipedia');
      expect(control.hardCeilingProgress).toBe('deliverable');
      expect(treatment.hardCeilingProgress).toBe('deliverable');
      expect(control.requires).toContain('network');
      expect(knowledgeEffectivenessKickoff(topic)).toBe(control.evidenceTexts?.[1]);
    },
  );
});
