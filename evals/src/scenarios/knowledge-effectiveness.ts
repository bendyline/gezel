import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { waitForKnowledgeInstall } from '../knowledge-install.ts';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { findWorkspaceDeliverableNearMiss, provisionScenarioGezel } from './helpers.ts';

/**
 * Paired knowledge-catalog effectiveness probes.
 *
 * Each topic has two prompt-identical scenarios. The control project sets
 * `knowledgeCatalogs.mode=off`; the treatment installs and selects one exact
 * catalog version. Both researchers retain the free Wikipedia tools; generic
 * web search is neither requested nor accepted as research evidence.
 * The artifact gate is deliberately identical across arms. Catalog use is an
 * observation, not a treatment-only pass condition: a catalog that is mounted
 * but ignored is important negative evidence rather than a broken trial.
 */

export type KnowledgeEffectivenessArm = 'control' | 'catalog';

export interface KnowledgeEffectivenessTopic {
  id: 'food-carbohydrates' | 'medicine-antibiotic-resistance' | 'astronomy-exoplanets';
  catalogId: string;
  catalogVersion: string;
  projectName: string;
  artifactPath: string;
  title: string;
  subjectPattern: RegExp;
  sections: readonly string[];
  coverage: ReadonlyArray<{ signal: string; label: string; pattern: RegExp }>;
  caveat: { signal: string; label: string; pattern: RegExp };
  brief: readonly string[];
}

const RESEARCHER_NAME = 'Mira';
const MIN_WORDS = 1_100;
const MAX_WORDS = 2_300;
const PINNED_PUBLISHER = 'bendyline';
const MIN_QUALITY_RATIO = 0.85;

interface KnowledgeRepairBudget {
  baseline: string;
  feedbackSent: boolean;
}

const knowledgeRepairBudgets = new WeakMap<EvalContext, Map<string, KnowledgeRepairBudget>>();

interface KnowledgeTrialTiming {
  setupStartedAt: number;
  kickoffAt?: number;
  catalogInstallMs?: number;
  catalogReadyAt?: string;
}

const knowledgeTrialTimings = new WeakMap<EvalContext, Map<string, KnowledgeTrialTiming>>();

function trialTiming(ctx: EvalContext, key: string): KnowledgeTrialTiming {
  const sharedKey = `knowledge-effectiveness:timing:${key}`;
  const shared = ctx.state?.get(sharedKey);
  if (shared) return shared as KnowledgeTrialTiming;
  if (ctx.state) {
    const timing: KnowledgeTrialTiming = { setupStartedAt: Date.now() };
    ctx.state.set(sharedKey, timing);
    return timing;
  }
  let timings = knowledgeTrialTimings.get(ctx);
  if (!timings) {
    timings = new Map();
    knowledgeTrialTimings.set(ctx, timings);
  }
  let timing = timings.get(key);
  if (!timing) {
    timing = { setupStartedAt: Date.now() };
    timings.set(key, timing);
  }
  return timing;
}

function repairBudget(ctx: EvalContext, key: string, markdown: string): KnowledgeRepairBudget {
  let budgets = knowledgeRepairBudgets.get(ctx);
  if (!budgets) {
    budgets = new Map();
    knowledgeRepairBudgets.set(ctx, budgets);
  }
  let budget = budgets.get(key);
  if (!budget) {
    budget = { baseline: markdown, feedbackSent: false };
    budgets.set(key, budget);
  }
  return budget;
}

export const KNOWLEDGE_EFFECTIVENESS_TOPICS: readonly KnowledgeEffectivenessTopic[] = [
  {
    id: 'food-carbohydrates',
    catalogId: 'wikipedia-food-drink',
    catalogVersion: '2026.4.5',
    projectName: 'Knowledge Study — Carbohydrates in Food',
    artifactPath: 'carbohydrates-report.md',
    title: 'The role of carbohydrates in food and human nutrition',
    subjectPattern: /\bcarbohydrate(?:s)?\b/i,
    sections: [
      'Executive summary',
      'What carbohydrates are',
      'Digestion, absorption, and metabolism',
      'Roles in foods and cooking',
      'Health evidence and controversies',
      'Practical implications',
      'Limitations',
      'Sources',
    ],
    coverage: [
      {
        signal: 'carb-classes',
        label: 'sugars, starch, and dietary fiber as distinct carbohydrate classes',
        pattern: /\bsugars?\b[\s\S]{0,500}\bstarch\b[\s\S]{0,500}\b(?:dietary\s+)?fib(?:er|re)\b/i,
      },
      {
        signal: 'digestion-enzymes',
        label: 'amylase and small-intestinal or brush-border digestion',
        pattern:
          /\bamylase\b[\s\S]{0,500}\b(?:small\s+intestin|brush[- ]border|maltase|sucrase|lactase)\w*/i,
      },
      {
        signal: 'absorption-transport',
        label: 'glucose/fructose absorption through SGLT1 and GLUT5',
        pattern: /\bSGLT\s*1\b[\s\S]{0,500}\bGLUT\s*5\b|\bGLUT\s*5\b[\s\S]{0,500}\bSGLT\s*1\b/i,
      },
      {
        signal: 'metabolism-storage',
        label: 'glycolysis, glycogen storage, and hormonal regulation',
        pattern: /\bglycolysis\b[\s\S]{0,650}\bglycogen\b[\s\S]{0,650}\b(?:insulin|glucagon)\b/i,
      },
      {
        signal: 'food-function',
        label:
          'a concrete cooking or food-structure role such as gelatinization, fermentation, or browning',
        pattern:
          /\b(?:gelatini[sz]ation|retrogradation|fermentation|maillard|carameli[sz]ation|thicken(?:ing|er)?)\b/i,
      },
      {
        signal: 'glycemic-context',
        label: 'glycemic index/load with a limitation or food-context qualification',
        pattern:
          /\bglyc(?:a?emic|emic)\s+(?:index|load)\b[\s\S]{0,500}\b(?:limit|context|portion|mixed meal|var(?:y|ies|iation)|individual)\w*/i,
      },
      {
        signal: 'fiber-health',
        label: 'fiber, the gut microbiome or fermentation, and health outcomes',
        pattern:
          /\bfib(?:er|re)\b[\s\S]{0,600}\b(?:microbiom|ferment|short-chain|bowel|cardiovascular|cholesterol)\w*/i,
      },
    ],
    caveat: {
      signal: 'carb-calibration',
      label: 'an explicit warning that carbohydrates are not one nutritionally uniform category',
      pattern:
        /\b(?:not all|cannot be treated as|should not be treated as|vary widely|quality matters)\b[\s\S]{0,180}\bcarbohydrate\w*|\bcarbohydrate\w*\b[\s\S]{0,180}\b(?:not\s+(?:a\s+)?(?:nutritionally\s+)?uniform|not\s+interchangeable|vary widely|quality matters)\b/i,
    },
    brief: [
      'Classify sugars, starches, and dietary fiber rather than treating all carbohydrates as interchangeable.',
      'Explain digestion and absorption, including amylase, brush-border enzymes, SGLT1, and GLUT5; then connect glycolysis, glycogen, insulin, and glucagon.',
      'Explain at least one physical or chemical role carbohydrates play during cooking or food production.',
      'Assess glycemic index/load, fiber and the gut microbiome, added versus intrinsic sugars, and why food matrix and dietary pattern complicate simple good/bad claims.',
    ],
  },
  {
    id: 'medicine-antibiotic-resistance',
    catalogId: 'wikipedia-medicine',
    catalogVersion: '2026.4.5',
    projectName: 'Knowledge Study — Antibiotic Resistance',
    artifactPath: 'antibiotic-resistance-report.md',
    title: 'How antibiotic resistance emerges and how stewardship responds',
    subjectPattern: /\bantibiotic\s+resistance\b/i,
    sections: [
      'Executive summary',
      'Evolution and acquisition of resistance',
      'Molecular mechanisms',
      'Clinical and public-health consequences',
      'Stewardship and prevention',
      'One Health perspective',
      'Limitations',
      'Sources',
    ],
    coverage: [
      {
        signal: 'selection-pressure',
        label: 'selection pressure acting on bacterial populations',
        pattern: /\bselection\s+pressure\b[\s\S]{0,450}\b(?:bacteri|population|resistan)\w*/i,
      },
      {
        signal: 'acquisition-paths',
        label: 'mutation and horizontal gene transfer',
        pattern:
          /\bmutation\w*\b[\s\S]{0,550}\bhorizontal\s+gene\s+transfer\b|\bhorizontal\s+gene\s+transfer\b[\s\S]{0,550}\bmutation\w*\b/i,
      },
      {
        signal: 'mechanism-enzymes',
        label: 'drug inactivation such as beta-lactamase',
        pattern:
          /\b(?:beta[- ]?lactamase|β[- ]?lactamase|enzymatic\s+(?:degradation|inactivation)|drug\s+inactivation)\b/i,
      },
      {
        signal: 'mechanism-target',
        label: 'target alteration or replacement',
        pattern: /\b(?:target\s+(?:alteration|modification|replacement)|altered\s+target)\b/i,
      },
      {
        signal: 'mechanism-access',
        label: 'efflux or reduced permeability',
        pattern: /\b(?:efflux(?:\s+pump)?|reduced\s+permeability|porin\w*)\b/i,
      },
      {
        signal: 'clinical-consequences',
        label: 'treatment failure or worse clinical outcomes',
        pattern:
          /\b(?:treatment\s+failure|mortality|morbidity|longer\s+(?:hospital|illness)|limited\s+treatment\s+options)\b/i,
      },
      {
        signal: 'stewardship-actions',
        label:
          'specific stewardship actions such as diagnostics, spectrum, dose, route, or duration review',
        pattern:
          /\b(?:diagnostic\s+stewardship|culture\w*|narrow[- ]spectrum|de[- ]escalat|dose\s+optimi[sz]|duration\s+review|antibiogram)\w*/i,
      },
      {
        signal: 'one-health',
        label: 'One Health connections among human, animal, and environmental systems',
        pattern:
          /\bone\s+health\b[\s\S]{0,650}\b(?:animal|livestock)\w*[\s\S]{0,650}\benvironment\w*/i,
      },
    ],
    caveat: {
      signal: 'resistance-calibration',
      label: 'the clarification that microbes, not a patient body, become resistant',
      pattern:
        /\b(?:bacteria|microbes?|pathogens?)\b[\s\S]{0,220}\b(?:become|are)\s+resistant\b[\s\S]{0,220}\b(?:not|rather than)\b[\s\S]{0,120}\b(?:person|patient|body|people|human)\b/i,
    },
    brief: [
      'Explain natural selection, mutation, and horizontal gene transfer without saying that a patient body becomes resistant.',
      'Compare drug inactivation, target modification, efflux/reduced permeability, and biofilm-related tolerance.',
      'Connect mechanisms to clinical and public-health consequences, then assess concrete stewardship, infection-prevention, surveillance, vaccination, and diagnostic responses.',
      'Include a One Health perspective spanning human medicine, animal use, and environmental pathways. Keep this educational and avoid personalized treatment advice.',
    ],
  },
  {
    id: 'astronomy-exoplanets',
    catalogId: 'wikipedia-astronomy',
    catalogVersion: '2026.4.5',
    projectName: 'Knowledge Study — Exoplanet Detection',
    artifactPath: 'exoplanet-detection-report.md',
    title: 'How astronomers detect and characterize exoplanets',
    subjectPattern: /\bexoplanet\w*\b/i,
    sections: [
      'Executive summary',
      'Detection methods',
      'From signals to planet properties',
      'Selection effects and false positives',
      'Atmospheres and habitability',
      'Future directions',
      'Limitations',
      'Sources',
    ],
    coverage: [
      {
        signal: 'transit-method',
        label: 'transit depth, orbital period, and radius inference',
        pattern:
          /\btransit\w*\b[\s\S]{0,550}\b(?:depth|dimming)\b[\s\S]{0,550}\b(?:radius|orbital\s+period)\b/i,
      },
      {
        signal: 'radial-velocity',
        label: 'radial velocity/Doppler measurements and minimum mass',
        pattern:
          /\bradial\s+velocity\b[\s\S]{0,550}\b(?:doppler|minimum\s+mass|m\s*sin\s*i|semi-amplitude)\b/i,
      },
      {
        signal: 'other-methods',
        label: 'at least two of direct imaging, microlensing, astrometry, or timing',
        pattern:
          /\b(?:direct\s+imaging|microlensing|astrometry|timing)\b[\s\S]{0,850}\b(?:direct\s+imaging|microlensing|astrometry|timing)\b/i,
      },
      {
        signal: 'density-combination',
        label: 'combining mass and radius to estimate density/composition',
        pattern:
          /\bmass\b[\s\S]{0,350}\bradius\b[\s\S]{0,350}\b(?:density|composition)\b|\bradius\b[\s\S]{0,350}\bmass\b[\s\S]{0,350}\b(?:density|composition)\b/i,
      },
      {
        signal: 'selection-bias',
        label: 'selection bias toward short-period, large, or massive planets',
        pattern:
          /\b(?:selection\s+(?:effect|bias)|detection\s+bias|observational\s+bias)\b[\s\S]{0,550}\b(?:short[- ]period|large|massive|close[- ]in|hot jupiter)\w*/i,
      },
      {
        signal: 'false-positives',
        label: 'false positives and confirmation or validation',
        pattern:
          /\bfalse\s+positive\w*\b[\s\S]{0,550}\b(?:confirm|validat|follow[- ]up|blend|eclipsing binar)\w*/i,
      },
      {
        signal: 'atmosphere-spectroscopy',
        label: 'transmission/emission spectroscopy for atmospheric characterization',
        pattern:
          /\b(?:transmission|emission)\s+spectroscop\w*\b[\s\S]{0,500}\b(?:atmospher|molecule|spectrum|spectra)\w*/i,
      },
    ],
    caveat: {
      signal: 'habitability-calibration',
      label:
        'a warning that the habitable zone or a biosignature candidate does not establish inhabited life',
      pattern:
        /\b(?:habitable\s+zone|biosignature)\b[\s\S]{0,350}\b(?:does\s+not|is\s+not|not\s+(?:proof|evidence)|insufficient|uncertain|ambiguous)\b[\s\S]{0,180}\b(?:life|inhabited|habitability)\b/i,
    },
    brief: [
      'Compare transit and radial-velocity measurements with direct imaging, microlensing, astrometry, and timing methods.',
      'Explain what each method measures, how mass and radius combine into density, and why follow-up is needed.',
      'Analyze selection effects and important false-positive pathways rather than presenting the observed population as an unbiased census.',
      'Explain atmospheric spectroscopy and discuss habitability cautiously: neither a habitable-zone orbit nor one candidate biosignature proves life.',
    ],
  },
] as const;

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
}

function headingPositions(markdown: string, headings: readonly string[]): number[] {
  return headings.map((heading) => {
    const words = heading
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    return markdown.search(new RegExp(`^##\\s+${words}\\s*$`, 'im'));
  });
}

function sourcesSection(markdown: string): string {
  const start = markdown.search(/^##\s+Sources\s*$/im);
  if (start < 0) return '';
  const afterHeading = markdown.indexOf('\n', start);
  if (afterHeading < 0) return '';
  const rest = markdown.slice(afterHeading + 1);
  const next = rest.search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function sourceEntryCount(markdown: string): number {
  const section = sourcesSection(markdown);
  return section.split('\n').filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[\d+\]\s+)/.test(line))
    .length;
}

function inlineCitationCount(markdown: string): number {
  const beforeSources = markdown.split(/^##\s+Sources\s*$/im)[0] ?? markdown;
  const markers = new Set<string>();
  for (const match of beforeSources.matchAll(/\[(?:\d{1,2}|[^\]\n]{2,80})\](?:\([^\s)]+\))?/g)) {
    const marker = match[0];
    if (!/^\[(?:executive summary|sources?|limitations?)\]$/i.test(marker)) markers.add(marker);
  }
  for (const match of beforeSources.matchAll(/knowledge:\/\/[^\s)>]+|https?:\/\/[^\s)>]+/g)) {
    markers.add(match[0]);
  }
  return markers.size;
}

export interface KnowledgeReportCheck extends SniffResult {
  scoreMax: number;
  words: number;
}

/** Prompt-identical artifact grader used by both arms. */
export function checkKnowledgeEffectivenessReport(
  markdown: string,
  topic: KnowledgeEffectivenessTopic,
): KnowledgeReportCheck {
  const signals: string[] = [];
  const missing: string[] = [];
  const reasons: string[] = [];
  const pass = (signal: string) => signals.push(signal);
  const fail = (signal: string, reason: string) => {
    missing.push(signal);
    reasons.push(reason);
  };

  const words = wordCount(markdown);
  if (words >= MIN_WORDS && words <= MAX_WORDS) pass('word-band');
  else fail('word-band', `report is ${words} words; required range is ${MIN_WORDS}-${MAX_WORDS}`);

  if (topic.subjectPattern.test(markdown)) pass('subject');
  else fail('subject', `report does not substantively discuss ${topic.title}`);

  const positions = headingPositions(markdown, topic.sections);
  if (
    positions.every((position) => position >= 0) &&
    positions.every((position, index) => index === 0 || position > positions[index - 1]!)
  ) {
    pass('ordered-sections');
  } else {
    fail('ordered-sections', `missing or out-of-order H2 sections: ${topic.sections.join(', ')}`);
  }

  for (const gate of topic.coverage) {
    if (gate.pattern.test(markdown)) pass(gate.signal);
    else fail(gate.signal, `missing grounded coverage: ${gate.label}`);
  }

  if (topic.caveat.pattern.test(markdown)) pass(topic.caveat.signal);
  else fail(topic.caveat.signal, `missing calibrated caveat: ${topic.caveat.label}`);

  const entries = sourceEntryCount(markdown);
  if (entries >= 4) pass('source-list');
  else fail('source-list', `Sources needs at least 4 distinct entries; found ${entries}`);

  const citations = inlineCitationCount(markdown);
  if (citations >= 2) pass('inline-citations');
  else
    fail(
      'inline-citations',
      `needs at least 2 distinct inline citations or links; found ${citations}`,
    );

  const scoreMax = 6 + topic.coverage.length;
  return {
    ok: missing.length === 0,
    signals,
    score: signals.length,
    scoreMax,
    words,
    ...(reasons[0] ? { failReason: reasons.slice(0, 3).join('; ') } : {}),
    ...(missing.length > 0 ? { missingRequiredSignals: missing } : {}),
  };
}

function topicById(id: KnowledgeEffectivenessTopic['id']): KnowledgeEffectivenessTopic {
  const topic = KNOWLEDGE_EFFECTIVENESS_TOPICS.find((candidate) => candidate.id === id);
  if (!topic) throw new Error(`unknown knowledge-effectiveness topic ${id}`);
  return topic;
}

export function knowledgeEffectivenessKickoff(topic: KnowledgeEffectivenessTopic): string {
  return [
    `Write a rigorous research report titled "${topic.title}" to \`${topic.artifactPath}\` at the workspace root.`,
    `Write ${MIN_WORDS}-${MAX_WORDS} words and use these H2 sections in this exact order: ${topic.sections.join('; ')}.`,
    'Research before writing. Use the reference sources available in this project: call wikipedia_search and wikipedia_read, and use locally indexed knowledge when it is available. Generic web search is not available; do not rely only on model memory.',
    'Cite evidence inline near the claims it supports and finish with at least four distinct source entries. Preserve source URLs or knowledge:// citations when a tool provides them.',
    ...topic.brief,
    'Distinguish well-established mechanisms from interpretation or uncertainty. Do not ask a follow-up question. Write the complete report now with write_file.',
  ].join(' ');
}

function knowledgeEffectivenessMission(topic: KnowledgeEffectivenessTopic): string {
  return [
    `Produce ${topic.artifactPath}: a sourced ${MIN_WORDS}-${MAX_WORDS}-word report on ${topic.title}.`,
    `Use the required section order (${topic.sections.join('; ')}), research the project's available reference sources before drafting, cite claims inline, and list at least four sources.`,
    ...topic.brief,
  ].join(' ');
}

function localArchivePath(topic: KnowledgeEffectivenessTopic): string | null {
  const dir = process.env.GEZEL_EVAL_KNOWLEDGE_ARCHIVE_DIR?.trim();
  if (!dir) return null;
  const path = join(dir, `${topic.catalogId}-${topic.catalogVersion}.gezk`);
  if (!existsSync(path)) {
    throw new Error(
      `GEZEL_EVAL_KNOWLEDGE_ARCHIVE_DIR is set but ${path} is missing; cache the pinned archive or unset the variable`,
    );
  }
  return path;
}

async function installPinnedCatalog(ctx: EvalContext, topic: KnowledgeEffectivenessTopic) {
  const installStartedAt = Date.now();
  const localPath = localArchivePath(topic);
  if (localPath) {
    const { jobId } = await ctx.client.installKnowledgeCatalog({
      source: { kind: 'file', path: localPath },
    });
    await waitForKnowledgeInstall(ctx.client, jobId, {
      label: `${topic.catalogId}@${topic.catalogVersion}`,
      log: ctx.log,
    });
    ctx.log(
      `[scenario:setup] installed ${topic.catalogId}@${topic.catalogVersion} from ${localPath}`,
    );
  } else {
    let lastProgressBucket = -1;
    await ctx.client.installKnowledgeCatalogFromCatalog(
      topic.catalogId,
      (event) => {
        const progress =
          'progress' in event && typeof event.progress === 'number' ? event.progress : 0;
        const bucket = Math.floor(progress / 25);
        if (bucket > lastProgressBucket) {
          lastProgressBucket = bucket;
          ctx.log(`[scenario:setup] ${topic.catalogId} install ${Math.min(100, bucket * 25)}%`);
        }
      },
      undefined,
      { version: topic.catalogVersion, placement: 'user' },
    );
    ctx.log(`[scenario:setup] installed ${topic.catalogId}@${topic.catalogVersion} from gilde`);
  }

  const { catalogs } = await ctx.client.listKnowledgeCatalogs();
  const installed = catalogs.find(
    (catalog) =>
      catalog.ref.publisherId === PINNED_PUBLISHER &&
      catalog.ref.catalogId === topic.catalogId &&
      catalog.ref.version === topic.catalogVersion,
  );
  if (!installed?.enabled || !installed.mounted) {
    throw new Error(
      `${topic.catalogId}@${topic.catalogVersion} did not mount enabled (status=${JSON.stringify(installed ?? null)})`,
    );
  }
  return {
    installed,
    catalogInstallMs: Date.now() - installStartedAt,
    catalogReadyAt: new Date().toISOString(),
  };
}

async function findProjectId(
  client: EvalContext['client'],
  topic: KnowledgeEffectivenessTopic,
): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === topic.projectName)?.id ?? null;
}

async function readWorkspaceReport(
  client: EvalContext['client'],
  projectId: string,
  path: string,
): Promise<string | null> {
  try {
    return await (await client.fetchProjectWorkspaceBlob(projectId, path)).text();
  } catch {
    return null;
  }
}

interface ResearchChannels {
  knowledge: boolean;
  wikipedia: boolean;
  researchTools: string[];
  outOfScopeWebTools: string[];
  knowledgeHits: number;
  knowledgeSourceCount: number;
  retrievalCalls: number;
  /** Null when the successful write landed before the current turn committed. */
  distinctResultSets: number | null;
  observedSourceCount: number;
  artifactMutations: number;
  reportRewrites: number;
  factualWriteRejections: number;
  unsupportedClaimCount: number;
  firstSourceAt?: string;
  firstKnowledgeHitAt?: string;
  firstArtifactAt?: string;
  lastArtifactAt?: string;
}

/** A lookup performed after the accepted report write is not grounding. */
export function researchPrecededReport(
  firstSourceAt: string | undefined,
  lastArtifactAt: string | undefined,
): boolean {
  if (!firstSourceAt || !lastArtifactAt) return false;
  const source = Date.parse(firstSourceAt);
  const artifact = Date.parse(lastArtifactAt);
  return Number.isFinite(source) && Number.isFinite(artifact) && source <= artifact;
}

/**
 * A citation-shaped URL is not evidence that the model actually researched
 * with Wikipedia. Require an observed successful Wikipedia tool call so a
 * model cannot pass the control arm by inventing plausible-looking links.
 */
export function wikipediaResearchObserved(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => /^wikipedia_(?:search|read)$/i.test(name));
}

/**
 * Automatic retrieval produces counted knowledge hits. Manual retrieval via
 * the unified `search` tool instead leaves its strongest durable evidence in
 * the report as a knowledge URI. Require the tool and URI together so a bare
 * citation-shaped string cannot prove catalog use by itself.
 */
export function knowledgeResearchObserved(options: {
  knowledgeHits: number;
  knowledgeSourceCount: number;
}): boolean {
  return options.knowledgeHits > 0 || options.knowledgeSourceCount > 0;
}

async function researchChannels(
  client: EvalContext['client'],
  projectId: string,
  markdown: string,
  artifactPath: string,
): Promise<ResearchChannels> {
  const history = await client.listHistory({ limit: 2_000 }).catch(() => ({ entries: [] }));
  const tools = new Set<string>();
  const outOfScopeWebTools = new Set<string>();
  let knowledgeHits = 0;
  let firstSourceAt: string | undefined;
  let firstKnowledgeHitAt: string | undefined;
  let firstArtifactAt: string | undefined;
  let lastArtifactAt: string | undefined;
  let retrievalCalls = 0;
  let artifactMutations = 0;
  let factualWriteRejections = 0;
  const reportSourceRefs = new Set(
    [...markdown.matchAll(/(?:knowledge:\/\/|https?:\/\/)[^\s)>\]]+/gi)].map((match) =>
      match[0].replace(/[.,;:]+$/, ''),
    ),
  );
  const toolSourceRefs = new Set<string>();
  const mutationTools = new Set([
    'write_file',
    'replace_in_file',
    'append_to_file',
    'apply_patch',
    'insert_at_marker',
  ]);
  for (const entry of history.entries ?? []) {
    if (entry.entryType !== 'event' || entry.projectId !== projectId) continue;
    const details = (entry.details ?? {}) as Record<string, unknown>;
    if (entry.kind === 'tool.called' && typeof details.name === 'string') {
      if (/^(?:web_search|fetch_url|browser_)/i.test(details.name)) {
        outOfScopeWebTools.add(details.name);
      }
      if (
        details.success !== false &&
        /^(?:search|read_document|wikipedia_search|wikipedia_read)$/i.test(details.name)
      ) {
        tools.add(details.name);
        if (!firstSourceAt || entry.at < firstSourceAt) firstSourceAt = entry.at;
      }
      if (
        details.success !== false &&
        /^(?:search|read_document|wikipedia_search|wikipedia_read)$/i.test(details.name)
      ) {
        retrievalCalls += 1;
      }
      if (
        details.success !== false &&
        details.name === 'read_document' &&
        typeof details.path === 'string' &&
        /^(?:knowledge:\/\/|https?:\/\/)/i.test(details.path)
      ) {
        toolSourceRefs.add(details.path);
        if (
          details.path.startsWith('knowledge://') &&
          (!firstKnowledgeHitAt || entry.at < firstKnowledgeHitAt)
        ) {
          firstKnowledgeHitAt = entry.at;
        }
      }
      if (mutationTools.has(details.name) && details.path === artifactPath.replace(/^\.\//, '')) {
        if (details.success === true) {
          artifactMutations += 1;
          if (!firstArtifactAt || entry.at < firstArtifactAt) firstArtifactAt = entry.at;
          if (!lastArtifactAt || entry.at > lastArtifactAt) lastArtifactAt = entry.at;
        } else if (/no evidence|Not saved:/i.test(String(details.errorMessage ?? ''))) {
          factualWriteRejections += 1;
        }
      }
    }
    if (entry.kind === 'retrieval.context-injected' && Array.isArray(details.hits)) {
      const added = (details.hits as Array<{ source?: unknown }>).filter(
        (hit) => hit.source === 'knowledge',
      ).length;
      knowledgeHits += added;
      if (added > 0) {
        if (!firstKnowledgeHitAt || entry.at < firstKnowledgeHitAt) firstKnowledgeHitAt = entry.at;
        if (!firstSourceAt || entry.at < firstSourceAt) firstSourceAt = entry.at;
      }
    }
  }
  const resultSets = new Set<string>();
  let sessionRetrievalCalls = 0;
  let unsupportedClaimCount = 0;
  const sessionList = await client.listChatSessions({ projectId }).catch(() => ({ sessions: [] }));
  for (const summary of sessionList.sessions) {
    const session = await client.getChatSession(summary.id).catch(() => null);
    if (!session) continue;
    for (const message of session.messages) {
      unsupportedClaimCount += message.grounding?.problems.length ?? 0;
      for (const call of message.toolCalls ?? []) {
        if (/^(?:search|read_document|wikipedia_search|wikipedia_read)$/i.test(call.name)) {
          sessionRetrievalCalls += 1;
          const refs = [
            ...(call.path?.match(/^(?:knowledge:\/\/|https?:\/\/).+/i)
              ? [call.path.match(/^(?:knowledge:\/\/|https?:\/\/).+/i)!]
              : []),
            ...(call.resultText ?? '').matchAll(/(?:knowledge:\/\/|https?:\/\/)[^\s)>\]]+/gi),
          ]
            .map((match) => match[0].replace(/[.,;:]+$/, ''))
            .sort();
          for (const ref of refs) toolSourceRefs.add(ref);
          const signature =
            refs.length > 0
              ? refs.join('\n')
              : (call.resultText ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
          if (signature) resultSets.add(signature);
          if (call.success && call.at && (!firstSourceAt || call.at < firstSourceAt)) {
            firstSourceAt = call.at;
          }
          if (
            call.success &&
            call.at &&
            refs.some((ref) => ref.startsWith('knowledge://')) &&
            (!firstKnowledgeHitAt || call.at < firstKnowledgeHitAt)
          ) {
            firstKnowledgeHitAt = call.at;
          }
        }
        // Counts and mutation chronology come from project history above.
        // The current assistant turn may not be committed into the session
        // yet when its successful write makes this grader run.
      }
    }
  }
  const researchTools = [...tools].sort();
  const knowledgeSourceCount = [...toolSourceRefs].filter((ref) =>
    ref.startsWith('knowledge://'),
  ).length;
  const allSourceRefs = new Set([...reportSourceRefs, ...toolSourceRefs]);
  return {
    knowledge: knowledgeResearchObserved({ knowledgeHits, knowledgeSourceCount }),
    wikipedia: wikipediaResearchObserved(researchTools),
    researchTools,
    outOfScopeWebTools: [...outOfScopeWebTools].sort(),
    knowledgeHits,
    knowledgeSourceCount,
    retrievalCalls,
    distinctResultSets: retrievalCalls > 0 && sessionRetrievalCalls === 0 ? null : resultSets.size,
    observedSourceCount: allSourceRefs.size,
    artifactMutations,
    reportRewrites: Math.max(0, artifactMutations - 1),
    factualWriteRejections,
    unsupportedClaimCount,
    ...(firstSourceAt ? { firstSourceAt } : {}),
    ...(firstKnowledgeHitAt ? { firstKnowledgeHitAt } : {}),
    ...(firstArtifactAt ? { firstArtifactAt } : {}),
    ...(lastArtifactAt ? { lastArtifactAt } : {}),
  };
}

function elapsedFromKickoff(timing: KnowledgeTrialTiming, at: string | undefined): number | null {
  if (!timing.kickoffAt || !at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? Math.max(0, parsed - timing.kickoffAt) : null;
}

function experimentMetrics(
  timing: KnowledgeTrialTiming,
  channels: ResearchChannels,
): Record<string, unknown> {
  return {
    catalogInstallMs: timing.catalogInstallMs ?? null,
    catalogReadyAt: timing.catalogReadyAt ?? null,
    firstSourceMs: elapsedFromKickoff(timing, channels.firstSourceAt),
    firstKnowledgeHitMs: elapsedFromKickoff(timing, channels.firstKnowledgeHitAt),
    firstArtifactMs: elapsedFromKickoff(timing, channels.firstArtifactAt),
    retrievalCalls: channels.retrievalCalls,
    distinctResultSets: channels.distinctResultSets,
    observedSourceCount: channels.observedSourceCount,
    knowledgeSourceCount: channels.knowledgeSourceCount,
    artifactMutations: channels.artifactMutations,
    reportRewrites: channels.reportRewrites,
    factualWriteRejections: channels.factualWriteRejections,
    unsupportedClaimCount: channels.unsupportedClaimCount,
    researchPrecededReport: researchPrecededReport(channels.firstSourceAt, channels.lastArtifactAt),
  };
}

export function makeKnowledgeEffectivenessScenario(
  topicId: KnowledgeEffectivenessTopic['id'],
  arm: KnowledgeEffectivenessArm,
): EvalScenario {
  const topic = topicById(topicId);
  const kickoff = knowledgeEffectivenessKickoff(topic);
  const mission = knowledgeEffectivenessMission(topic);
  const armLabel = arm === 'catalog' ? 'catalog treatment' : 'no-catalog control';
  const scenarioKey = `knowledge-${topic.id}-${arm}`;

  return {
    id: `knowledge-${topic.id}-${arm}`,
    description: `${topic.title} — ${armLabel}. Prompt-identical paired research task; the control disables every project knowledge catalog while retaining free Wikipedia tools, and the treatment selects ${topic.catalogId}@${topic.catalogVersion}. Generic web search is out of scope. Content gates are identical and catalog adoption is reported separately.`,
    prompt: `${RESEARCHER_NAME} is preparing the report in the "${topic.projectName}" project. No Meester action is needed; just acknowledge this note.`,
    modelNetworkAccess: 'wikipedia',
    requires: ['network'],
    evidenceTexts: [mission, kickoff],
    requiredPromptEvidence: [
      { signal: 'subject', pattern: topic.subjectPattern },
      { signal: 'ordered-sections', pattern: /H2 sections in this exact order/i },
      { signal: 'source-list', pattern: /at least four distinct source entries/i },
      { signal: 'inline-citations', pattern: /cite evidence inline/i },
    ],
    retrievalOracle:
      arm === 'catalog'
        ? {
            golden: [`knowledge://${PINNED_PUBLISHER}/${topic.catalogId}/`],
            decoys: [],
          }
        : undefined,
    requiresEmbeddings: true,
    setupTimeoutMs: 10 * 60_000,
    timeoutMs: 45 * 60_000,
    // More searches are useful only until the requested report exists and
    // improves. Do not let retrieval/coordination churn turn a bounded
    // research comparison into a 2x wall-clock run.
    hardCeilingProgress: 'deliverable',
    progressTimeoutMs: 15 * 60_000,
    skipInitialPrompt: true,
    setup: async (ctx) => {
      const timing = trialTiming(ctx, scenarioKey);
      if (arm === 'catalog') {
        const installed = await installPinnedCatalog(ctx, topic);
        timing.catalogInstallMs = installed.catalogInstallMs;
        timing.catalogReadyAt = installed.catalogReadyAt;
        ctx.log(
          `[scenario:setup] catalog ready in ${installed.catalogInstallMs}ms at ${installed.catalogReadyAt}`,
        );
      }

      let projectId = await findProjectId(ctx.client, topic);
      if (!projectId) {
        const created = await ctx.client.createProject({
          name: topic.projectName,
          about:
            'A paired evaluation project for a source-grounded long-form research report. The report must distinguish established evidence from uncertainty and preserve auditable provenance.',
          missionObjectives: mission,
        });
        projectId = created.id;
        ctx.log(`[scenario:setup] created project name="${topic.projectName}" id=${projectId}`);
      }
      if (!projectId) throw new Error(`${topic.id} setup: failed to resolve project id`);

      await ctx.client.updateProject(projectId, {
        knowledgeCatalogs:
          arm === 'catalog'
            ? {
                mode: 'selected',
                refs: [{ publisherId: PINNED_PUBLISHER, catalogId: topic.catalogId }],
              }
            : { mode: 'off' },
      });
      ctx.log(
        `[scenario:setup] project knowledge scope=${arm === 'catalog' ? `${PINNED_PUBLISHER}/${topic.catalogId}` : 'off'}`,
      );

      const researcher = await provisionScenarioGezel(ctx, {
        preferredName: RESEARCHER_NAME,
        role: 'Researcher',
        label: 'researcher',
      });
      await ctx.client.addGezelToProject(projectId, researcher.id);
      timing.kickoffAt = Date.now();
      await ctx.client.sendChatMessage(researcher.id, { message: kickoff, projectId });
      ctx.log(`[scenario:setup] sent prompt-identical kickoff to ${researcher.name}`);
    },
    successCheck: async (ctx): Promise<SuccessCheckResult> => {
      const projectId = await findProjectId(ctx.client, topic);
      if (!projectId) {
        ctx.logChanged('project', `[scenario] ${topic.projectName} is not present yet`);
        return { done: false };
      }
      const markdown = await readWorkspaceReport(ctx.client, projectId, topic.artifactPath);
      if (markdown === null) {
        ctx.logChanged('sniff', `[scenario] ${topic.artifactPath} not present yet`);
        ctx.recordSniff?.({ key: `knowledge-${topic.id}-${arm}`, score: 0, bytes: 0 });
        const nearMiss = await findWorkspaceDeliverableNearMiss(
          ctx.client,
          projectId,
          topic.artifactPath,
        );
        await postMissingDeliverableFeedback(ctx, topic.artifactPath, {
          minPolls: 18,
          repeatEvery: 18,
          maxNudges: 2,
          nearMiss,
          projectId,
        });
        return { done: false };
      }

      const active = await ctx.client
        .listInflightTurns({ projectId })
        .catch(() => ({ inflight: [] }));
      if (active.inflight.length > 0) {
        ctx.logChanged(
          'sniff',
          `[scenario] ${topic.artifactPath} is present, but ${active.inflight.length} project turn(s) are still active; waiting for committed tool history before scoring`,
        );
        return { done: false };
      }

      const content = checkKnowledgeEffectivenessReport(markdown, topic);
      const channels = await researchChannels(ctx.client, projectId, markdown, topic.artifactPath);
      const metrics = experimentMetrics(trialTiming(ctx, scenarioKey), channels);
      const sourceEvidence = channels.knowledge || channels.wikipedia;
      const groundedReport =
        sourceEvidence && researchPrecededReport(channels.firstSourceAt, channels.lastArtifactAt);
      const controlContaminated = arm === 'control' && channels.knowledge;
      const outOfScopeWeb = channels.outOfScopeWebTools.length > 0;
      const signals = [...content.signals, ...(groundedReport ? ['researched-source'] : [])];
      const scoreMax = content.scoreMax + 1;
      const score = content.score + (groundedReport ? 1 : 0);
      const qualityThreshold = Math.ceil(scoreMax * MIN_QUALITY_RATIO);
      const requiredSignals = [
        'word-band',
        'subject',
        'ordered-sections',
        'source-list',
        'inline-citations',
        'researched-source',
      ];
      const missingCoreSignals = requiredSignals.filter((signal) => !signals.includes(signal));
      const missing = [
        ...(content.missingRequiredSignals ?? []),
        ...(!groundedReport ? ['researched-source'] : []),
        ...(controlContaminated ? ['control-isolation'] : []),
        ...(outOfScopeWeb ? ['wikipedia-only-isolation'] : []),
      ];
      const channelSummary = `knowledge=${channels.knowledge ? 'yes' : 'no'} autoHits=${channels.knowledgeHits} sources=${channels.knowledgeSourceCount} wikipedia=${channels.wikipedia ? 'yes' : 'no'} researchBeforeReport=${groundedReport ? 'yes' : 'no'} tools=${channels.researchTools.join(',') || 'none'} outOfScopeWeb=${channels.outOfScopeWebTools.join(',') || 'none'}`;
      const failReason = controlContaminated
        ? `control project received knowledge-catalog evidence (${channelSummary})`
        : outOfScopeWeb
          ? `generic web tools are out of scope for this no-key comparison but were called: ${channels.outOfScopeWebTools.join(', ')}`
          : !sourceEvidence
            ? 'no successful Wikipedia research or knowledge-catalog evidence was observed'
            : !groundedReport
              ? 'research was observed only after the accepted report write; revise the report after consulting the returned evidence'
              : content.failReason;
      const check: SniffResult = {
        ok:
          score >= qualityThreshold &&
          missingCoreSignals.length === 0 &&
          !controlContaminated &&
          !outOfScopeWeb,
        signals,
        score,
        scoreMax,
        ...(failReason ? { failReason } : {}),
        ...(missing.length > 0 ? { missingRequiredSignals: missing } : {}),
      };

      ctx.logChanged(
        'sniff',
        `[scenario] knowledge-${topic.id}-${arm} bytes=${markdown.length} words=${content.words} score=${score}/${scoreMax} channels="${channelSummary}" signals=${signals.join(',') || 'none'}${failReason ? ` failReason="${failReason}"` : ''}`,
      );
      ctx.recordSniff?.({
        key: `knowledge-${topic.id}-${arm}`,
        score,
        bytes: markdown.length,
        ...(failReason ? { failReason } : {}),
      });
      if (check.ok) {
        return {
          done: true,
          success: true,
          reason: `research report passed ${score}/${scoreMax} deterministic signals (threshold ${qualityThreshold}; ${channelSummary})`,
          diagnostics: {
            arm,
            catalogId: arm === 'catalog' ? topic.catalogId : null,
            catalogUsed: channels.knowledge,
            wikipediaUsed: channels.wikipedia,
            knowledgeHits: channels.knowledgeHits,
            knowledgeSourceCount: channels.knowledgeSourceCount,
            researchTools: channels.researchTools,
            outOfScopeWebTools: channels.outOfScopeWebTools,
            words: content.words,
            score,
            scoreMax,
            qualityThreshold,
            signals,
            missingSignals: missing,
            ...metrics,
          },
        };
      }
      const budgetKey = `knowledge-${topic.id}-${arm}`;
      const budget = repairBudget(ctx, budgetKey, markdown);
      if (budget.feedbackSent && budget.baseline !== markdown) {
        return {
          done: true,
          success: false,
          reason: `one bounded report revision completed but core quality requirements still failed: ${failReason ?? missing.slice(0, 4).join(', ')}`,
          failureMode: 'success-check-false',
          diagnostics: {
            arm,
            catalogId: arm === 'catalog' ? topic.catalogId : null,
            catalogUsed: channels.knowledge,
            wikipediaUsed: channels.wikipedia,
            knowledgeHits: channels.knowledgeHits,
            knowledgeSourceCount: channels.knowledgeSourceCount,
            researchTools: channels.researchTools,
            outOfScopeWebTools: channels.outOfScopeWebTools,
            words: content.words,
            score,
            scoreMax,
            qualityThreshold,
            signals,
            missingSignals: missing,
            repairBudgetExhausted: true,
            ...metrics,
          },
        };
      }
      if (failReason) {
        const feedback = await postSniffFeedback(ctx, topic.artifactPath, check, {
          projectId,
          sourceText: markdown,
          repairDirective: !sourceEvidence
            ? 'Call wikipedia_search and wikipedia_read now (or use project search when a catalog is selected), then revise the report with citations from the returned sources.'
            : !groundedReport
              ? 'The source lookup happened after the report was written. Use the returned evidence now, then revise the report so its claims and citations are grounded in those results.'
              : 'Patch the report to fix the named coverage, structure, calibration, or citation gaps while preserving sections that already pass.',
          ...(!groundedReport
            ? {
                expectedDeliverable: null,
                postReadMutationTarget: topic.artifactPath,
              }
            : {}),
        });
        if (feedback.status === 'sent') {
          budget.baseline = markdown;
          budget.feedbackSent = true;
        } else if (!budget.feedbackSent) {
          budget.baseline = markdown;
        }
      }
      return { done: false };
    },
  };
}

export function knowledgeEffectivenessScenarios(): EvalScenario[] {
  return KNOWLEDGE_EFFECTIVENESS_TOPICS.flatMap((topic) => [
    makeKnowledgeEffectivenessScenario(topic.id, 'control'),
    makeKnowledgeEffectivenessScenario(topic.id, 'catalog'),
  ]);
}
