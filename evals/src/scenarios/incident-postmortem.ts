import type { GezelClient } from '@bendyline/gezel-client/node';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import { countDistinctMatches, requireOrderedSections } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  type PersistedFixtureContents,
  type SeedFixtureIntegrityResult,
  checkSeedFixtureIntegrity,
  describeSeedFixtureIntegrityFailure,
} from './fixture-integrity.ts';
import { provisionScenarioGezel } from './helpers.ts';

/**
 * Incident postmortem — dense reading + structured writing.
 *
 * Pre-seeds an internally-consistent evidence pack from a fictional
 * production incident (checkout 500-rate spike on 2026-03-14, caused by
 * a deploy that changed the payment-gateway timeout). The model must
 * read all five evidence files and produce a competent SRE postmortem
 * at the workspace root.
 *
 * Defining traits:
 *   - The 8 canonical SRE sections must appear in canonical order.
 *   - At least 5 distinct evidence-filename citations across the doc.
 *   - At least 3 timestamp citations (`HH:MM` format).
 *   - 6 KB to 30 KB (substance bar, not padding bar).
 *   - "No invented facts" — deterministic gates require the evidence
 *     pack's critical facts and reject confident claims that exceed what
 *     the measured metrics, incident scope, or source topology establish.
 *     The optional judge remains advisory.
 *
 * The fixture pack is **internally consistent** by design:
 *   - The error spike in metrics.csv (14:32 UTC) matches the deploy
 *     completion in deploy.log (14:32:08).
 *   - The oncall chat references the same window.
 *   - The hotfix.diff reverts the deploy's timeout change.
 */

const PROJECT_NAME = 'Checkout Incident Postmortem';
const SRE_NAME = 'Jordan';

const REQUIRED_SECTIONS = [
  'Summary',
  'Impact',
  'Timeline',
  'Root cause',
  'Contributing factors',
  'What went well',
  'What went poorly',
  'Action items',
] as const;

const EVIDENCE_FILENAMES = [
  'timeline.md',
  'metrics.csv',
  'deploy.log',
  'oncall-chat.txt',
  'hotfix.diff',
] as const;

/** Personal identities explicitly present in the fixed evidence pack. */
const EVIDENCE_PERSON_NAMES = new Set(['mira chen', 'bertha vargas', 'phil okeke', 'anita sayed']);

/** Chat-style identities explicitly present in the evidence pack. */
const EVIDENCE_HANDLES = new Set(['mira.chen', 'bertha.vargas', 'phil.okeke']);

const BLAME_WORDS = [
  /\bfault\b/i,
  /\bincompetent\b/i,
  /should\s+have\s+known/i,
  /messed up/i,
  /screwed up/i,
] as const;

/** Match ordered facts within a bounded span instead of treating a report as
 * an unordered token bag. Every expression is evaluated case-insensitively. */
function orderedWithin(text: string, terms: readonly RegExp[], maxGap: number): boolean {
  const source = terms.map((term) => `(?:${term.source})`).join(`[\\s\\S]{0,${maxGap}}`);
  return new RegExp(source, 'i').test(text);
}

/**
 * Critical facts that a grounded postmortem must recover from the evidence
 * pack. These deliberately check the reusable incident-analysis contract
 * (change, mechanism, chronology, impact, response, mitigation), not prose
 * wording or a memorized reference answer.
 */
const GROUNDED_FACT_CHECKS: ReadonlyArray<{
  label: string;
  test: (text: string) => boolean;
}> = [
  {
    label: 'PR #3094 timeout change from 800ms to 8000ms',
    test: (text) =>
      /(?:PR\s*)?#?3094\b/i.test(text) &&
      /\btimeout\b/i.test(text) &&
      orderedWithin(
        text,
        [
          /\b800\s*(?:ms|milliseconds?)\b/,
          /(?:\bto\b|[-=]>|→)/,
          /\b8[ ,]?000\s*(?:ms|milliseconds?)\b/,
        ],
        80,
      ),
  },
  {
    label: 'connection-pool saturation/exhaustion mechanism',
    test: (text) =>
      /\bconnection\s+pool\b/i.test(text) && /\b(?:saturat\w*|exhaust\w*)\b/i.test(text),
  },
  {
    label: '14:32 deploy followed by the 14:33 error/latency spike',
    test: (text) =>
      orderedWithin(
        text,
        [
          /\b14:32(?::\d{2})?\b/,
          /\b(?:deploy|rollout)\w*\b/,
          /\b14:33(?::\d{2})?\b/,
          /\b(?:error|latency|p99|spike)\w*\b/,
        ],
        240,
      ) ||
      orderedWithin(
        text,
        [
          /\b(?:deploy|rollout)\w*\b/,
          /\b14:32(?::\d{2})?\b/,
          /\b14:33(?::\d{2})?\b/,
          /\b(?:error|latency|p99|spike)\w*\b/,
        ],
        240,
      ),
  },
  {
    label: '13% error peak and 99% saturation impact',
    test: (text) => {
      const errorPeak =
        orderedWithin(text, [/\b(?:error|failure)\w*\b/, /\b13(?:\.1)?\s*%/], 100) ||
        orderedWithin(text, [/\b13(?:\.1)?\s*%/, /\b(?:error|failure)\w*\b/], 100);
      const saturationPeak =
        orderedWithin(text, [/\b(?:saturat|utiliz)\w*\b/, /\b99\s*%/], 100) ||
        orderedWithin(text, [/\b99\s*%/, /\b(?:saturat|utiliz)\w*\b/], 100);
      return errorPeak && saturationPeak;
    },
  },
  {
    label: 'Bertha Vargas first response and Mira Chen incident command',
    test: (text) => {
      const berthaResponded =
        orderedWithin(
          text,
          [/\bBertha\s+Vargas\b/, /\b(?:first responder|on-?call|first response|respond\w*)\b/],
          120,
        ) ||
        orderedWithin(
          text,
          [/\b(?:first responder|on-?call|first response|respond\w*)\b/, /\bBertha\s+Vargas\b/],
          120,
        );
      const miraCommanded =
        orderedWithin(text, [/\bMira\s+Chen\b/, /\b(?:incident commander|IC|command\w*)\b/], 120) ||
        orderedWithin(text, [/\b(?:incident commander|IC|command\w*)\b/, /\bMira\s+Chen\b/], 120);
      return berthaResponded && miraCommanded;
    },
  },
  {
    label: 'v4.18.1/8155 revert and recovery by 14:54',
    test: (text) => {
      const mitigation =
        orderedWithin(text, [/\b(?:revert\w*|hotfix)\b/, /\b(?:v?4\.18\.1|8155)\b/], 160) ||
        orderedWithin(text, [/\b(?:v?4\.18\.1|8155)\b/, /\b(?:revert\w*|hotfix)\b/], 160);
      const recovery =
        orderedWithin(
          text,
          [
            /\b14:54(?::\d{2})?\b/,
            /(?:\brecover\w*\b|\bbaseline\b|\bbelow\s+1\s*%(?=\W|$)|<\s*1\s*%(?=\W|$))/,
          ],
          160,
        ) ||
        orderedWithin(
          text,
          [
            /(?:\brecover\w*\b|\bbaseline\b|\bbelow\s+1\s*%(?=\W|$)|<\s*1\s*%(?=\W|$))/,
            /\b14:54(?::\d{2})?\b/,
          ],
          160,
        );
      return mitigation && recovery;
    },
  },
];

function missingGroundedFactLabels(text: string): string[] {
  return GROUNDED_FACT_CHECKS.filter((check) => !check.test(text)).map((check) => check.label);
}

interface UnsupportedEvidenceClaimCheck {
  label: string;
  test: (text: string) => boolean;
}

/**
 * Split prose into claim-sized clauses. Metric comparisons often place two
 * supported values in one sentence ("latency was 5s while saturation was
 * 99%"); treating the whole sentence as one bag of tokens creates the same
 * false-positive problem as the grounded-fact checks this evaluator replaced.
 */
function evidenceClaimClauses(text: string): string[] {
  return text
    .split(
      /\n+|[.!?;]\s+|\s+\b(?:while|whereas)\b\s+|\s+\band\b\s+(?=(?:the\s+)?(?:connection[-\s]?pool|pool\s+saturation|saturation|p(?:95|99)|latency|error(?:\s+rate)?))/i,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** Explicit uncertainty is allowed; missing evidence must not be converted
 * into either a positive or negative conclusion. */
function explicitlyLeavesClaimUnknown(clause: string): boolean {
  return (
    /\b(?:evidence|sources?|source\s+files?|records?|metrics?|diff)\b[\s\S]{0,100}\b(?:does|do|did)\s+not\s+(?:show|establish|demonstrate|prove|support|confirm|indicate|measure)\b/i.test(
      clause,
    ) ||
    /\b(?:not\s+enough|insufficient)\s+evidence\s+to\s+(?:show|establish|conclude|determine|prove|support|confirm)\b/i.test(
      clause,
    ) ||
    /\b(?:unknown|unclear|not\s+established|not\s+measured)\s+(?:whether|if)\b/i.test(clause)
  );
}

/**
 * The evidence has a latency duration and a separate pool-saturation
 * percentage. Reject clauses that attach a percentage directly to p95/p99 or
 * latency, while allowing supported side-by-side paraphrases that state a
 * duration for latency and identify pool saturation as the percentage metric.
 */
function conflatesLatencyWithPercentageSaturation(text: string): boolean {
  for (const clause of evidenceClaimClauses(text)) {
    if (explicitlyLeavesClaimUnknown(clause)) continue;
    const candidate = clause.match(
      /\b(?:p(?:95|99)(?:\s+latency)?|latency(?:\s+(?:metric|percentile))?)\b[\s\S]{0,180}?\b99(?:\.0+)?\s*%/i,
    )?.[0];
    if (!candidate) continue;

    const separatesMeasuredLatencyFromSaturation =
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec(?:onds?)?)\b[\s\S]{0,100}\b(?:connection[-\s]?pool\s+)?saturat\w*\b/i.test(
        candidate,
      ) ||
      /\b(?:connection[-\s]?pool\s+)?saturat\w*\b[\s\S]{0,100}\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec(?:onds?)?)\b/i.test(
        candidate,
      );
    if (!separatesMeasuredLatencyFromSaturation) return true;
  }
  return false;
}

/** The observed peak is partial request failure, not evidence that the whole
 * service stopped accepting or processing traffic. */
function claimsTotalProcessingInability(text: string): boolean {
  const assertions = [
    /\b(?:checkout[- ]?api|service|system|application|api|endpoint)\b[\s\S]{0,80}\b(?:was|became|is|remained|rendered|left)\s+(?:effectively\s+|completely\s+|entirely\s+|totally\s+)?unable\s+to\s+(?:process|serve|handle|accept)\s+(?:any\s+|all\s+|new\s+)?(?:requests?|traffic|checkouts?|transactions?)\b/i,
    /\b(?:checkout[- ]?api|service|system|application|api|endpoint)\b[\s\S]{0,80}\b(?:could|can|did)\s+not\s+(?:process|serve|handle|accept)\s+(?:any\s+|all\s+|new\s+)?(?:requests?|traffic|checkouts?|transactions?)\b/i,
    /\b(?:no|zero)\s+(?:new\s+)?(?:requests?|traffic|checkouts?|transactions?)\s+(?:could\s+be|were)\s+(?:processed|served|handled|accepted)\b/i,
    /\b(?:all|every|100\s*%\s+of)\s+(?:checkout\s+)?(?:requests?|transactions?)\s+(?:failed|timed\s+out|were\s+rejected)\b/i,
  ];
  return evidenceClaimClauses(text).some(
    (clause) =>
      !explicitlyLeavesClaimUnknown(clause) &&
      assertions.some((assertion) => assertion.test(clause)),
  );
}

function isConfigurationAuditQuestion(clause: string): boolean {
  return (
    /\b(?:audit|investigate|determine|verify|check|assess|review|confirm)\s+(?:whether|if)\b/i.test(
      clause,
    ) || /\b(?:unknown|unclear|not\s+established)\s+(?:whether|if)\b/i.test(clause)
  );
}

/** A one-line client diff establishes that client's timeout, not the topology
 * of every checkout dependency. Allow audits/questions; reject assertions of
 * whole-flow uniformity or missing granular configuration. */
function extrapolatesWholeFlowConfiguration(text: string): boolean {
  const wholeFlowScope =
    /\b(?:single|one|same|shared|global)\s+(?:service\s+)?timeout(?:\s+(?:value|setting|configuration))?[\s\S]{0,120}\b(?:across|for|throughout)\s+(?:the\s+)?(?:entire|whole|all)\b[\s\S]{0,80}\b(?:checkout|flow|service|system|dependencies|clients?|gateways?|integrations?)\b/i;
  const reverseWholeFlowScope =
    /\b(?:all|every)\s+(?:checkout\s+)?(?:dependencies|clients?|gateways?|integrations?|services?)\b[\s\S]{0,100}\b(?:share|use|rely\s+on|have)\s+(?:the\s+)?(?:same|single|one|global)\s+timeout\b/i;
  const missingGranularity =
    /\b(?:lack|absence)\s+of\s+(?:granular|per[- ](?:dependency|client|gateway|integration|service)|dependency[- ]specific|client[- ]specific)\s+(?:timeout\s+)?(?:configuration|settings?|timeouts?|management)\b|\bno\s+(?:granular|per[- ](?:dependency|client|gateway|integration|service)|dependency[- ]specific|client[- ]specific)\s+(?:timeout\s+)?(?:configuration|settings?|timeouts?)\b/i;

  return evidenceClaimClauses(text).some((clause) => {
    if (explicitlyLeavesClaimUnknown(clause) || isConfigurationAuditQuestion(clause)) return false;
    return (
      wholeFlowScope.test(clause) ||
      reverseWholeFlowScope.test(clause) ||
      missingGranularity.test(clause)
    );
  });
}

/**
 * Definitive claims the evidence pack does not support. A grounded report may
 * state that evidence is missing or recommend an audit; it may not turn
 * missing measurements, a partial error rate, or a one-client diff into a
 * confident incident fact.
 */
const UNSUPPORTED_EVIDENCE_CLAIM_CHECKS: ReadonlyArray<UnsupportedEvidenceClaimCheck> = [
  {
    label: 'unsupported assertion that no data loss occurred',
    test: (text) => /\b(?:no|without)\s+(?:customer\s+)?data\s+loss\b/i.test(text),
  },
  {
    label: 'unsupported assertion that data was not lost or corrupted',
    test: (text) => /\b(?:data|records?)\s+(?:was|were)\s+not\s+(?:lost|corrupted)\b/i.test(text),
  },
  {
    label: 'unsupported assertion that no security/privacy impact occurred',
    test: (text) =>
      /\b(?:no|without)\s+(?:known\s+)?(?:security|privacy)\s+(?:breach|incident|impact|compromise)\b/i.test(
        text,
      ),
  },
  {
    label: 'unsupported assertion that security/privacy was unaffected',
    test: (text) =>
      /\b(?:security|privacy)\s+(?:was|were)\s+not\s+(?:affected|impacted|compromised)\b/i.test(
        text,
      ),
  },
  {
    label: 'unsupported assertion that data loss or a security/privacy breach occurred',
    test: (text) =>
      /\b(?:caused|resulted\s+in|included)\s+(?:a\s+)?(?:data\s+loss|security\s+breach|privacy\s+breach)\b/i.test(
        text,
      ),
  },
  {
    label:
      'unsupported metric relationship: assigns the percentage saturation value to p99/latency',
    test: conflatesLatencyWithPercentageSaturation,
  },
  {
    label:
      'unsupported total-unavailability claim: says the service could not process new requests',
    test: claimsTotalProcessingInability,
  },
  {
    label:
      'unsupported configuration-scope inference: generalizes one client timeout to the whole checkout flow or asserts missing granularity',
    test: extrapolatesWholeFlowConfiguration,
  },
];

function unsupportedEvidenceClaimLabels(text: string): string[] {
  return UNSUPPORTED_EVIDENCE_CLAIM_CHECKS.filter(({ test }) => test(text)).map(
    ({ label }) => label,
  );
}

export interface IncidentPostmortemVerdict {
  signals: string[];
  failures: string[];
  score: number;
  failReason?: string;
  hardSignals: string[];
  evidenceIntegrity: SeedFixtureIntegrityResult;
  success: boolean;
}

interface ParsedActionTableRow {
  raw: string;
  owner: string;
}

interface ActionItemsAssessment {
  listItems: string[];
  tableRows: ParsedActionTableRow[];
  ownerCount: number;
  invalidOwners: string[];
}

function splitMarkdownTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isMarkdownTableDelimiter(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function normalizeMarkdownCell(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlaceholderActionOwner(owner: string): boolean {
  return (
    /^(?:[-—–]|n\/?a|none|null|unknown|unassigned|tbd|todo|pending|later)$/i.test(owner) ||
    /^(?:assign(?:ed)?\s+later|to\s+be\s+(?:assigned|determined)|not\s+assigned)$/i.test(owner) ||
    /^(?:\[|<)?(?:owner|dri|assignee)(?:]|>)?$/i.test(owner) ||
    /^@?(?:owner|dri|assignee|unknown|unassigned|tbd)$/i.test(owner) ||
    /^(?:the\s+)?(?:(?:appropriate|responsible|relevant)\s+)?(?:team|owner|person|engineer|individual)$/i.test(
      owner,
    )
  );
}

function looksLikePersonalName(value: string): boolean {
  const nameParts = value.split(/\s+/);
  return (
    nameParts.length >= 2 &&
    nameParts.length <= 5 &&
    nameParts.every((part) => /^(?:[A-Z][\p{L}'’.-]*|[A-Z]\.)$/u.test(part))
  );
}

function isEvidencePersonName(value: string): boolean {
  return EVIDENCE_PERSON_NAMES.has(value.toLowerCase());
}

function isConcreteHandle(value: string): boolean {
  const handle = value.replace(/^@/, '').toLowerCase();
  if (EVIDENCE_HANDLES.has(handle)) return true;
  // The prompt explicitly permits handles as concrete DRIs. Preserve that
  // surface for functional handles such as @checkout-oncall, while the
  // placeholder filter above still rejects @owner / @tbd.
  return /^@[a-z][\w-]*$/i.test(value) || /^[a-z][\w-]*\.[a-z][\w-]*$/i.test(value);
}

function isSpecificActionTeamOrRole(value: string): boolean {
  return /^(?:sre(?:\s+(?:team|owner|on-?call|rotation))?|platform(?:\s+(?:team|eng(?:ineering)?|owner))?|release(?:\s+engineering)?(?:\s+(?:team|owner))?|observability(?:\s+(?:team|owner))?|security(?:\s+(?:team|owner))?|infra(?:structure)?(?:\s+(?:team|owner))?|operations?(?:\s+(?:team|owner))?|ops(?:\s+(?:team|owner))?|devops(?:\s+(?:team|owner))?|site\s+reliability(?:\s+(?:team|owner))?|qa(?:\s+team)?|quality\s+assurance(?:\s+team)?|engineering\s+(?:management|mgmt)(?:\s+team)?|checkout(?:-api)?\s+(?:team|owner|on-?call|rotation)|payment(?:s|\s+gateway)?\s+(?:team|owner))$/i.test(
    value,
  );
}

function isAtomicConcreteActionOwner(value: string): boolean {
  const owner = normalizeMarkdownCell(value);
  if (!owner || isPlaceholderActionOwner(owner)) return false;

  const bracketed = owner.match(/^\[([^\]]+)]$/)?.[1];
  if (bracketed) return isAtomicConcreteActionOwner(bracketed);

  const roleSuffix = owner.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (roleSuffix) {
    const identity = roleSuffix[1]?.trim() ?? '';
    if (isEvidencePersonName(identity) || isConcreteHandle(identity)) return true;
    if (isSpecificActionTeamOrRole(identity)) return true;
    // A role suffix must not make an unseen person look grounded. This is
    // the frozen `Jordan (SRE)` / `Sarah Chen (Platform Eng)` failure mode.
    if (looksLikePersonalName(identity) || /^[A-Z][\p{L}'’.-]*$/u.test(identity)) return false;
    return false;
  }

  if (isConcreteHandle(owner)) return true;
  if (isSpecificActionTeamOrRole(owner)) return true;
  if (looksLikePersonalName(owner)) return isEvidencePersonName(owner);
  return false;
}

/**
 * The evidence-writing contract allows evidence-grounded people, concrete
 * handles, and specific teams/roles. Slash/ampersand/plus composites are
 * assessed component by component: a grounded co-owner cannot launder an
 * invented person or a placeholder in the same cell.
 */
function isConcreteActionOwner(value: string): boolean {
  const owner = normalizeMarkdownCell(value);
  if (!owner || isPlaceholderActionOwner(owner)) return false;
  const components = owner.split(/\s*(?:\/|&|\+)\s*/).filter(Boolean);
  return components.length > 0 && components.every(isAtomicConcreteActionOwner);
}

function listItemHasConcreteOwner(line: string): boolean {
  const explicitOwner = line.match(/\b(?:owner|dri|assignee)\s*[:=-]\s*([^;|.]+)/i)?.[1];
  if (explicitOwner && isConcreteActionOwner(explicitOwner)) return true;

  const leadingBracket = line.match(/^\s*(?:[-*]|\d+\.)\s+\[([^\]]+)]/)?.[1];
  if (leadingBracket && isConcreteActionOwner(leadingBracket)) return true;

  const handle = line.match(/(?:^|\s)(@[a-z][\w-]*)\b/i)?.[1];
  return handle ? isConcreteActionOwner(handle) : false;
}

function parseActionTable(actionBody: string): ParsedActionTableRow[] {
  const lines = actionBody.split('\n');
  for (let index = 0; index < lines.length - 1; index++) {
    const headerLine = lines[index];
    const delimiterLine = lines[index + 1];
    if (!headerLine?.includes('|') || !delimiterLine || !isMarkdownTableDelimiter(delimiterLine)) {
      continue;
    }

    const headers = splitMarkdownTableRow(headerLine).map((cell) =>
      normalizeMarkdownCell(cell).toLowerCase(),
    );
    const ownerIndex = headers.findIndex((header) => /^(?:owner|dri|assignee)$/.test(header));
    const actionIndex = headers.findIndex((header) =>
      /^(?:action|item|task|description|title)$/.test(header),
    );
    const rows: ParsedActionTableRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex++) {
      const raw = lines[rowIndex];
      if (!raw || raw.trim() === '' || !raw.includes('|')) break;
      const cells = splitMarkdownTableRow(raw);
      const action = normalizeMarkdownCell(cells[actionIndex >= 0 ? actionIndex : 0] ?? '');
      if (!action) continue;
      rows.push({
        raw,
        owner: ownerIndex >= 0 ? normalizeMarkdownCell(cells[ownerIndex] ?? '') : '',
      });
    }
    return rows;
  }
  return [];
}

function assessActionItems(actionBody: string): ActionItemsAssessment {
  const listItems = actionBody.split('\n').filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line));
  const tableRows = parseActionTable(actionBody);
  const validTableOwners = tableRows.filter((row) => isConcreteActionOwner(row.owner));
  const validListOwners = listItems.filter(listItemHasConcreteOwner);
  return {
    listItems,
    tableRows,
    ownerCount: validTableOwners.length + validListOwners.length,
    invalidOwners: tableRows
      .filter((row) => !isConcreteActionOwner(row.owner))
      .map((row) => row.owner || '<empty>'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Fixture: 5 evidence files. Hand-authored to be internally consistent;
// the deploy log's 14:32:08 completion matches the metrics.csv spike at
// 14:33 (one bucket after deploy completion), matches the oncall chat
// at 14:34, matches the hotfix.diff that reverts the timeout change.

const TIMELINE_MD = `# Checkout Incident — Timeline (UTC)

Incident commander: Mira Chen
Severity: SEV2
Service: checkout-api
Date: 2026-03-14

## Key events

- **14:28** Pre-deploy checks for checkout-api v4.18.0 pass on canary.
- **14:30** Deploy starts: rolling restart across 12 pods. CD pipeline
  ID 8147. Pull request #3094 — "raise PaymentGateway client timeout
  from 800ms to 8000ms".
- **14:32** Deploy completes. All 12 pods on v4.18.0.
- **14:33** error_rate jumps from 0.3% baseline to 9.1%. p99 latency
  rises from 220ms to 4.8s.
- **14:34** PagerDuty pages the checkout on-call rotation.
- **14:35** Oncall (Bertha Vargas) acknowledges. Joins #checkout-incident.
- **14:38** Bertha confirms the error mode: PaymentGateway client
  exhausting its connection pool while waiting on the bumped 8s timeout.
- **14:41** Mira Chen joins as incident commander.
- **14:46** Decision: revert PR #3094. Hotfix branch \`hotfix/payment-timeout-revert\`.
- **14:51** Hotfix CI green; deploy starts.
- **14:53** Hotfix deploy completes (v4.18.1 — same as v4.17.4 except the
  PaymentGateway timeout is back to 800ms).
- **14:54** error_rate drops below 1%. p99 latency recovers to 230ms.
- **14:58** Mira declares the incident resolved (10 min monitoring window).
- **15:08** Incident closed. SEV2 -> mitigated.

## Roles

- IC: Mira Chen
- On-call (first responder): Bertha Vargas
- Deploy owner (PR author): Phil Okeke

## Notes

PR #3094 had been merged 6 hours earlier but only rolled out in this
deploy. The PR description framed the change as a fix for occasional
800ms timeouts seen against PaymentGateway; the reviewer (Phil Okeke
self-merged after reviewer Anita Sayed signed off) didn't catch that a
10× longer timeout would saturate the connection pool under steady load.
`;

const METRICS_CSV = `timestamp_utc,request_rate_per_s,error_rate_pct,p99_latency_ms,saturation_pct
14:25:00,1240,0.3,218,42
14:26:00,1252,0.2,219,43
14:27:00,1271,0.3,221,43
14:28:00,1248,0.3,217,42
14:29:00,1262,0.3,220,43
14:30:00,1255,0.3,224,44
14:31:00,1244,0.4,231,45
14:32:00,1238,0.5,242,49
14:33:00,1241,9.1,4810,97
14:34:00,1233,12.4,5120,99
14:35:00,1229,13.1,5180,99
14:36:00,1221,12.8,5160,99
14:37:00,1217,12.5,5140,99
14:38:00,1218,11.9,5090,99
14:39:00,1215,11.7,5070,99
14:40:00,1213,11.5,5060,99
14:41:00,1209,11.4,5050,99
14:42:00,1207,11.3,5040,99
14:43:00,1203,11.2,5030,99
14:44:00,1198,11.1,5020,99
14:45:00,1194,11.0,5010,99
14:46:00,1191,10.9,5005,99
14:47:00,1188,10.8,4995,99
14:48:00,1185,10.7,4990,99
14:49:00,1182,10.6,4985,99
14:50:00,1179,10.5,4978,99
14:51:00,1180,10.4,4970,99
14:52:00,1180,9.8,4720,98
14:53:00,1181,3.4,1240,67
14:54:00,1198,0.9,238,46
14:55:00,1219,0.4,224,44
14:56:00,1232,0.4,222,44
14:57:00,1238,0.3,221,43
14:58:00,1240,0.3,219,43
`;

const DEPLOY_LOG = `[2026-03-14T14:30:00Z] cd-pipeline 8147 START service=checkout-api version=4.18.0 strategy=rolling pods=12
[2026-03-14T14:30:02Z] cd-pipeline 8147 pull-image v4.18.0 size=412MB elapsed=2.1s
[2026-03-14T14:30:18Z] cd-pipeline 8147 pod 1/12 READY new=v4.18.0
[2026-03-14T14:30:30Z] cd-pipeline 8147 pod 2/12 READY new=v4.18.0
[2026-03-14T14:30:42Z] cd-pipeline 8147 pod 3/12 READY new=v4.18.0
[2026-03-14T14:30:54Z] cd-pipeline 8147 pod 4/12 READY new=v4.18.0
[2026-03-14T14:31:06Z] cd-pipeline 8147 pod 5/12 READY new=v4.18.0
[2026-03-14T14:31:18Z] cd-pipeline 8147 pod 6/12 READY new=v4.18.0
[2026-03-14T14:31:30Z] cd-pipeline 8147 pod 7/12 READY new=v4.18.0
[2026-03-14T14:31:42Z] cd-pipeline 8147 pod 8/12 READY new=v4.18.0
[2026-03-14T14:31:54Z] cd-pipeline 8147 pod 9/12 READY new=v4.18.0
[2026-03-14T14:32:00Z] cd-pipeline 8147 pod 10/12 READY new=v4.18.0
[2026-03-14T14:32:04Z] cd-pipeline 8147 pod 11/12 READY new=v4.18.0
[2026-03-14T14:32:08Z] cd-pipeline 8147 pod 12/12 READY new=v4.18.0
[2026-03-14T14:32:08Z] cd-pipeline 8147 SUCCESS service=checkout-api version=4.18.0 duration=128s
[2026-03-14T14:46:30Z] cd-pipeline 8155 START service=checkout-api version=4.18.1 strategy=rolling pods=12 (hotfix)
[2026-03-14T14:46:32Z] cd-pipeline 8155 pull-image v4.18.1 size=412MB elapsed=1.9s
[2026-03-14T14:47:00Z] cd-pipeline 8155 pod 1/12 READY new=v4.18.1
[2026-03-14T14:47:12Z] cd-pipeline 8155 pod 2/12 READY new=v4.18.1
[2026-03-14T14:47:24Z] cd-pipeline 8155 pod 3/12 READY new=v4.18.1
[2026-03-14T14:47:36Z] cd-pipeline 8155 pod 4/12 READY new=v4.18.1
[2026-03-14T14:47:48Z] cd-pipeline 8155 pod 5/12 READY new=v4.18.1
[2026-03-14T14:48:00Z] cd-pipeline 8155 pod 6/12 READY new=v4.18.1
[2026-03-14T14:48:12Z] cd-pipeline 8155 pod 7/12 READY new=v4.18.1
[2026-03-14T14:48:24Z] cd-pipeline 8155 pod 8/12 READY new=v4.18.1
[2026-03-14T14:48:36Z] cd-pipeline 8155 pod 9/12 READY new=v4.18.1
[2026-03-14T14:48:48Z] cd-pipeline 8155 pod 10/12 READY new=v4.18.1
[2026-03-14T14:49:00Z] cd-pipeline 8155 pod 11/12 READY new=v4.18.1
[2026-03-14T14:53:00Z] cd-pipeline 8155 pod 12/12 READY new=v4.18.1
[2026-03-14T14:53:00Z] cd-pipeline 8155 SUCCESS service=checkout-api version=4.18.1 duration=390s
`;

const ONCALL_CHAT_TXT = `[14:34:11] PagerDuty: checkout-api error_rate > 5% for 60s — paging on-call
[14:34:48] bertha.vargas: ack — on it
[14:35:30] bertha.vargas: looking at /grafana/checkout — error_rate is 13% and p99 is 5s+
[14:36:14] bertha.vargas: this jumped at :33, right after the v4.18.0 deploy finished at :32
[14:37:22] bertha.vargas: errors are all 504 from /charge endpoint — PaymentGateway client timing out
[14:38:05] bertha.vargas: looking at the diff — PR #3094 just bumped PaymentGateway client timeout 800ms -> 8000ms
[14:38:41] bertha.vargas: under steady ~1200rps load, an 8s timeout means we hold connections 10x longer
[14:39:02] bertha.vargas: connection pool is at 99% saturation per metrics; that's the proximate cause
[14:39:34] bertha.vargas: I'm going to call this and revert PR #3094
[14:40:11] mira.chen: I'll IC. Bertha, please prep the revert PR
[14:41:30] mira.chen: opening #checkout-incident with all stakeholders
[14:42:05] mira.chen: phil.okeke joining — author of the offending PR
[14:42:38] phil.okeke: confirming — I bumped the timeout to absorb the rare 800ms slow path I saw against PaymentGateway in canary
[14:42:55] phil.okeke: I did not test under steady-state load. that's on me to make sure we test next time
[14:43:20] mira.chen: noted — let's get the revert deployed first, root-cause and action items after
[14:45:50] bertha.vargas: hotfix branch hotfix/payment-timeout-revert pushed; CI green
[14:46:30] bertha.vargas: deploy 8155 START
[14:53:08] bertha.vargas: deploy 8155 SUCCESS; error_rate already at 3% and falling
[14:54:30] bertha.vargas: error_rate < 1%, p99 < 250ms — we're back to baseline
[14:58:00] mira.chen: incident mitigated. monitoring for 10 more min then closing.
[15:08:00] mira.chen: closing — SEV2 mitigated. Postmortem due in 5 business days.
`;

const HOTFIX_DIFF = `diff --git a/checkout-api/src/payment/gateway-client.ts b/checkout-api/src/payment/gateway-client.ts
index 4a9c2b1..e21f6a0 100644
--- a/checkout-api/src/payment/gateway-client.ts
+++ b/checkout-api/src/payment/gateway-client.ts
@@ -41,7 +41,7 @@ export class PaymentGatewayClient {
   constructor(opts: { baseUrl: string }) {
     this.client = ky.create({
       prefixUrl: opts.baseUrl,
-      timeout: 8000,
+      timeout: 800,
       retry: { limit: 1, methods: ['get'] },
     });
   }
`;

export const INCIDENT_EVIDENCE_FILES: ReadonlyArray<{ path: string; content: string }> = [
  { path: 'evidence/timeline.md', content: TIMELINE_MD },
  { path: 'evidence/metrics.csv', content: METRICS_CSV },
  { path: 'evidence/deploy.log', content: DEPLOY_LOG },
  { path: 'evidence/oncall-chat.txt', content: ONCALL_CHAT_TXT },
  { path: 'evidence/hotfix.diff', content: HOTFIX_DIFF },
];

function expectedIncidentEvidenceContents(): PersistedFixtureContents {
  return new Map(INCIDENT_EVIDENCE_FILES.map((fixture) => [fixture.path, fixture.content]));
}

const JUDGE_CONTEXT_NOTE = [
  'The evidence pack describes a checkout-api 500-rate spike on 2026-03-14.',
  'The proximate cause was PR #3094, which raised the PaymentGateway client',
  'timeout from 800ms to 8000ms. Deploy 8147 completed at 14:32:08 UTC.',
  'The error rate spiked from 0.3% to 9.1% at 14:33 (one minute after deploy),',
  'reaching 13% by 14:35 with connection-pool saturation at 99%. PagerDuty',
  'paged at 14:34. Bertha Vargas was first responder; Mira Chen took IC at',
  '14:41. Phil Okeke (PR author) acknowledged the change at 14:42 — he had',
  'tested in canary but not under steady-state load. The hotfix (deploy 8155',
  'reverting #3094) completed at 14:53 and error_rate recovered to < 1% at',
  '14:54. Incident closed at 15:08. The hotfix.diff reverts the timeout from',
  '8000ms back to 800ms. A competent postmortem will identify the timeout',
  'change as the root cause, note the connection-pool saturation as the',
  'mechanism, credit the fast on-call response, and surface the lack of',
  'steady-state load testing in canary as the contributing factor.',
].join(' ');

export function incidentRepairDirective(
  failReason: string,
  bytes: number,
  missingSignals: string[],
  currentText = '',
  allFailures: string[] = [failReason],
): string {
  const needsLengthGate = missingSignals.includes('file-present');
  const needsMinimumSize = needsLengthGate && bytes < 6 * 1024;
  const needsMaximumSize = needsLengthGate && bytes > 30 * 1024;
  const needsGrounding =
    /grounded-core-facts/i.test(failReason) || missingSignals.includes('grounded-core-facts');
  const needsUnsupportedCertainty =
    /no-unsupported-certainty/i.test(failReason) ||
    missingSignals.includes('no-unsupported-certainty');
  const needsActions =
    /action-items-formatted/i.test(failReason) || missingSignals.includes('action-items-formatted');
  const combinedTargetCount = [
    needsLengthGate,
    needsGrounding,
    needsUnsupportedCertainty,
    needsActions,
  ].filter(Boolean).length;

  // A first-failure-only branch serializes independent misses. The July 10
  // Gemma trial kept receiving grounding patches while the 6 KiB floor and
  // action-owner gate remained unchanged. Give one preservation-oriented
  // plan for every known defect so no gate starves behind another.
  if (combinedTargetCount >= 2) {
    const steps: string[] = [];
    let step = 1;
    if (needsUnsupportedCertainty) {
      const unsupportedClaims = unsupportedEvidenceClaimLabels(currentText);
      steps.push(
        `${step++}. Use \`replace_in_file\` to remove or correct every unsupported evidence claim${unsupportedClaims.length > 0 ? `: ${unsupportedClaims.join('; ')}` : ' named by the acceptance failure'}. Keep latency duration separate from connection-pool saturation percentage, describe measured request failures without claiming total unavailability, restrict configuration facts to the PaymentGateway client shown in the diff, and state unmeasured outcomes as unknown.`,
      );
    }
    if (needsActions) {
      steps.push(
        `${step++}. Use \`replace_in_file\` to patch only \`## Action items\`. Keep at least three table rows and put an evidence-grounded person (Mira Chen, Bertha Vargas, Phil Okeke, or Anita Sayed), a concrete handle, or a specific functional team in every Owner cell. Slash-separated co-owners are allowed, but every component must be concrete. Do not invent personal names. Blank values and \`TBD\`, \`Team\`, \`Owner\`, \`Unknown\`, or \`Unassigned\` do not count.`,
      );
    }
    if (needsGrounding && !needsMinimumSize) {
      const missingFacts = missingGroundedFactLabels(currentText);
      steps.push(
        `${step++}. Patch the smallest relevant evidence-backed section(s) with \`replace_in_file\` so these fact groups are explicit and correctly related: ${missingFacts.join('; ') || 'the fact groups named by the acceptance failure'}.`,
      );
    }
    if (needsMinimumSize) {
      const addBytes = Math.max(1_500, 7 * 1024 - bytes);
      const groundingRequirement = needsGrounding
        ? ` The appended analysis must explicitly and correctly cover these missing fact groups: ${missingGroundedFactLabels(currentText).join('; ') || 'the fact groups named by the acceptance failure'}.`
        : '';
      steps.push(
        `${step++}. Use \`append_to_file\` to add at least ${addBytes} substantive evidence-backed characters under one new H3, clearing 7 KiB with headroom.${groundingRequirement}`,
      );
    } else if (needsMaximumSize) {
      steps.push(
        `${step++}. Use targeted \`replace_in_file\` edits to remove redundant prose until the document is at most 30 KiB; preserve every grounded fact, required H2, citation, and action row.`,
      );
    }

    const failureSummary = (allFailures.length > 0 ? allFailures : [failReason]).join(' | ');
    return [
      'INCIDENT POSTMORTEM COMBINED PATCH: fix every acceptance failure below in this same repair turn; do not stop after the first edit.',
      `Acceptance failures: ${failureSummary}.`,
      ...steps,
      'Do not call `write_file` or regenerate passing sections. Complete every numbered file edit before replying in chat, and do not invent impact beyond the evidence.',
    ].join(' ');
  }

  if (needsUnsupportedCertainty) {
    const unsupportedClaims = unsupportedEvidenceClaimLabels(currentText);
    return [
      'INCIDENT POSTMORTEM GROUNDING PATCH: remove the unsupported certainty claim from `postmortem.md` now.',
      `Unsupported claim classes: ${unsupportedClaims.join('; ') || failReason}.`,
      'Keep metric relationships exact: latency is measured as a duration and connection-pool saturation as a percentage. Describe the measured partial request failure without upgrading it to total service unavailability. The diff establishes one PaymentGateway client timeout, not whole-checkout configuration topology.',
      'For unmeasured outcomes or unknown configuration scope, state that the supplied evidence does not establish the conclusion or recommend an audit instead of asserting it as fact.',
      'Use a small `replace_in_file` edit and preserve the grounded sections, citations, and Action items table.',
      'Your next assistant action must be that file edit, not chat prose.',
    ].join(' ');
  }
  if (needsGrounding) {
    const missingFacts = missingGroundedFactLabels(currentText);
    return [
      'INCIDENT POSTMORTEM GROUNDING PATCH: re-read the relevant evidence file(s), then patch `postmortem.md` with the missing incident facts named by the acceptance failure.',
      `Current failure: ${failReason}.`,
      `Missing fact groups: ${missingFacts.join('; ') || 'use the fact groups named by the acceptance failure'}.`,
      'Keep the account causal and chronological: change, connection-pool mechanism, observed impact, response roles, revert, and recovery must agree with the supplied files.',
      'Do not add claims about impact categories the evidence does not measure.',
      'Your next assistant action must edit the file, not reply in chat.',
    ].join(' ');
  }
  if (/evidence-citations/i.test(failReason) || missingSignals.includes('evidence-citations')) {
    const cited = new Set(
      EVIDENCE_FILENAMES.filter((name) =>
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(currentText),
      ),
    );
    const missingEvidence = EVIDENCE_FILENAMES.filter((name) => !cited.has(name));
    const missingList =
      missingEvidence.length > 0
        ? missingEvidence.map((name) => `\`${name}\``).join(', ')
        : 'one of the five required evidence filenames';
    const hotfixHint = missingEvidence.includes('hotfix.diff')
      ? ' If `hotfix.diff` is missing, add this exact factual citation to Root cause or Action items: `The hotfix.diff confirms v4.18.1 reverted the PaymentGateway timeout from 8000ms back to 800ms (hotfix.diff).`'
      : '';
    return [
      'INCIDENT POSTMORTEM PATCH: patch `postmortem.md` now; do not rewrite unrelated sections.',
      `The missing evidence citation signal needs the document to name ${missingList}.`,
      hotfixHint,
      'Use a small `replace_in_file` edit when possible, or one complete `write_file` only if the replacement cannot match.',
      'Keep all eight required sections in order, keep the file at least 6 KB, and preserve the existing Action items table.',
      'Your next assistant action must be that file tool call, not chat prose.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (needsActions) {
    return [
      'INCIDENT POSTMORTEM PATCH: patch `postmortem.md` now. If the other sections are already solid, rewrite only `## Action items`; if the file is also under 6 KB, expand the evidence-backed sections too.',
      'Use a markdown table with at least 3 action rows and explicit owners in an `Owner` column.',
      'Exact shape to use: `| Action | Owner | Due | Evidence |` followed by rows such as `| Add steady-state load tests for timeout/retry changes | Platform/SRE team | 2026-03-28 | timeline.md 14:46; hotfix.diff |`.',
      'Every Owner cell must name an evidence-grounded person (`Mira Chen`, `Bertha Vargas`, `Phil Okeke`, or `Anita Sayed`), a concrete handle, or a specific team such as `Platform/SRE team`, `Release engineering`, `Observability`, or `checkout-api owner`. Slash-separated co-owners are allowed only when every component is concrete. Do not invent personal names. Blank values and `TBD`, `Team`, `Owner`, `Unknown`, or `Unassigned` do not count.',
      bytes < 6 * 1024
        ? `The current file is ${bytes}B; after the targeted Action items edit, use append_to_file({ path: "postmortem.md", content: <evidence-backed H3 analysis> }) to clear 7 KiB with headroom. Do not reply in chat between edits.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (/need\s*[≥>=]\s*6\s*KB|need\s*[≥>=]\s*6000|is\s+\d+B/i.test(failReason)) {
    // Leave real headroom above the 6 KiB gate. Whole-file rewrites were
    // observed shrinking an otherwise-complete postmortem on every repair
    // attempt (5.9 KiB -> 5.1 KiB -> 5.5 KiB). Appending a grounded H3 keeps
    // all passing H2 sections, citations, and the action table intact.
    const targetBytes = 7 * 1024;
    const addBytes = Math.max(1_500, targetBytes - bytes);
    return [
      'INCIDENT POSTMORTEM APPEND: the document already has the required structure but needs more evidence-backed substance.',
      `Append at least ${addBytes} substantive characters so the result clears 7 KiB with headroom; do not pad.`,
      'Your next tool call must be `append_to_file({ path: "postmortem.md", content: "\\n\\n### Evidence-backed follow-up context\\n\\n<new analysis>" })`. Do not call `write_file`, rewrite existing sections, or answer in chat first.',
      'In that new H3 subsection, connect the deploy and timestamps to the error/latency impact, explain the connection-pool mechanism, and state how the revert restored service, citing the supplied evidence filenames.',
      'Do not introduce a new H2 heading, duplicate the Summary, alter the existing Action items table, or claim data/security outcomes the evidence does not measure.',
    ].join(' ');
  }
  return [
    'INCIDENT POSTMORTEM PATCH: patch the existing `postmortem.md`, do not restart from chat prose.',
    'Keep the 8 required sections in canonical order.',
    'Cite all five evidence files by filename and at least three HH:MM timestamps.',
    'Ensure the file is at least 6 KB and the `## Action items` section has at least 3 rows/items with explicit owners.',
  ].join(' ');
}

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

/** Pure evaluator shared by the live poller and deterministic grader tests. */
export function evaluateIncidentPostmortem(
  postmortem: string,
  persistedEvidence: PersistedFixtureContents = expectedIncidentEvidenceContents(),
): IncidentPostmortemVerdict {
  const signals: string[] = [];
  const failures: string[] = [];
  const evidenceIntegrity = checkSeedFixtureIntegrity(INCIDENT_EVIDENCE_FILES, persistedEvidence);

  // Size gate: 6 KB to 30 KB.
  const bytes = postmortem.length;
  if (bytes >= 6 * 1024 && bytes <= 30 * 1024) signals.push('file-present');
  else if (bytes < 6 * 1024) failures.push(`postmortem.md is ${bytes}B (need ≥ 6 KB)`);
  else failures.push(`postmortem.md is ${bytes}B (exceeds 30 KB cap)`);

  // Section order.
  const sectionCheck = requireOrderedSections(postmortem, REQUIRED_SECTIONS);
  if (sectionCheck.ok) signals.push('all-sections');
  else failures.push(`all-sections: missing or out-of-order at "${sectionCheck.missing}"`);

  // Summary length — extract the Summary section's body (up to next H2)
  // and count sentences. Up to 8 sentences for an executive-readable
  // summary. Use a strict sentence-terminator regex that requires the
  // *following* character to be whitespace + a capital letter or
  // end-of-text — keeps `0.3 %`, `220 ms`, `v4.18.0` from fragmenting
  // into spurious sentence boundaries.
  const summaryBodyMatch = postmortem.match(/^#+\s+Summary\s*$([\s\S]*?)^#+\s+/im);
  if (summaryBodyMatch) {
    const body = (summaryBodyMatch[1] ?? '').replace(/\s+/g, ' ').trim();
    const sentenceEnds = (body.match(/[.!?](?=\s+[A-Z(]|\s*$)/g) ?? []).length;
    if (sentenceEnds >= 1 && sentenceEnds <= 8) signals.push('summary-concise');
    else if (sentenceEnds === 0)
      failures.push('summary-concise: Summary body has no recognized sentence terminator');
    else failures.push(`summary-concise: ${sentenceEnds} sentences (need 1-8)`);
  } else {
    failures.push('summary-concise: could not locate Summary body');
  }

  // Evidence citations — count distinct evidence filenames cited anywhere.
  const evidenceRegex = new RegExp(`\\b(${EVIDENCE_FILENAMES.join('|')})\\b`, 'gi');
  const distinctEvidence = countDistinctMatches(postmortem, evidenceRegex);
  if (distinctEvidence >= 5) signals.push('evidence-citations');
  else failures.push(`evidence-citations: ${distinctEvidence} distinct (need ≥ 5)`);

  // Timestamp citations — `HH:MM` (or `HH:MM:SS`), distinct.
  const timestampRegex = /\b(\d{2}:\d{2}(?::\d{2})?)\b/g;
  const distinctTs = countDistinctMatches(postmortem, timestampRegex);
  if (distinctTs >= 3) signals.push('timestamp-citations');
  else failures.push(`timestamp-citations: ${distinctTs} distinct (need ≥ 3)`);

  // Critical evidence-pack facts. Citation tokens alone do not prove the
  // model understood the incident; require the change, mechanism,
  // chronology, impact, responders, and mitigation to agree with the pack.
  const missingGroundedFacts = missingGroundedFactLabels(postmortem);
  if (missingGroundedFacts.length === 0 && evidenceIntegrity.ok) {
    signals.push('grounded-core-facts');
  } else {
    const groundingFailures: string[] = [];
    if (missingGroundedFacts.length > 0) {
      groundingFailures.push(`missing ${missingGroundedFacts.join('; ')}`);
    }
    if (!evidenceIntegrity.ok) {
      groundingFailures.push(
        `evidence-integrity: ${describeSeedFixtureIntegrityFailure(evidenceIntegrity)}`,
      );
    }
    failures.push(`grounded-core-facts: ${groundingFailures.join('; ')}`);
  }

  // Missing evidence is not evidence of absence or of a broader scope.
  // Reject unsupported impact, metric-relationship, total-unavailability,
  // and configuration-topology claims while allowing explicit uncertainty,
  // supported side-by-side metric paraphrases, and audit recommendations.
  const unsupportedCertainty = unsupportedEvidenceClaimLabels(postmortem);
  if (unsupportedCertainty.length === 0) signals.push('no-unsupported-certainty');
  else failures.push(`no-unsupported-certainty: ${unsupportedCertainty.join('; ')}`);

  // Action items — at least 3 items in the Action items section, each with
  // a concrete DRI. For the required markdown-table shape,
  // inspect the Owner/DRI/Assignee cell structurally: words such as "SRE"
  // in the Action or Evidence cells cannot rescue a blank/vague owner.
  // Retain explicit-owner list support for older otherwise-valid reports.
  const headingMatch = postmortem.match(/^#+\s+Action items?\s*$/im);
  let actionBody: string | null = null;
  if (headingMatch && headingMatch.index !== undefined) {
    const after = postmortem.slice(headingMatch.index + headingMatch[0].length);
    const nextHeading = after.match(/\n#+\s/);
    actionBody =
      nextHeading && nextHeading.index !== undefined ? after.slice(0, nextHeading.index) : after;
  }
  if (actionBody !== null) {
    const assessment = assessActionItems(actionBody);
    const itemCount = assessment.listItems.length + assessment.tableRows.length;
    if (itemCount >= 3 && assessment.ownerCount === itemCount) {
      signals.push('action-items-formatted');
    } else {
      const invalidOwnerDetail =
        assessment.invalidOwners.length > 0
          ? `; invalid Owner cells: ${assessment.invalidOwners
              .slice(0, 3)
              .map((owner) => `"${owner}"`)
              .join(', ')}`
          : '';
      failures.push(
        `action-items-formatted: ${itemCount} items (${assessment.listItems.length} list + ${assessment.tableRows.length} table rows), ${assessment.ownerCount} with concrete owner${invalidOwnerDetail}`,
      );
    }
  } else {
    failures.push('action-items-formatted: could not locate Action items section');
  }

  // No-blame language remains a soft signal.
  const blameHits = BLAME_WORDS.filter((re) => re.test(postmortem));
  if (blameHits.length === 0) signals.push('no-blame-language');

  const hardSignals = signals.filter((signal) => signal !== 'no-blame-language');
  const failReason = failures[0];
  return {
    signals,
    failures,
    score: signals.length,
    ...(failReason ? { failReason } : {}),
    hardSignals,
    evidenceIntegrity,
    success: hardSignals.length === 8,
  };
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A production incident pack from 2026-03-14: checkout-api saw a 500-rate ' +
        'spike after a deploy that changed the payment-gateway timeout. The ' +
        'evidence files in workspace/evidence/ are: timeline.md, metrics.csv, ' +
        'deploy.log, oncall-chat.txt, hotfix.diff. The team should read all five ' +
        'and produce a competent SRE postmortem at workspace/postmortem.md.',
      missionObjectives: [
        '1. Read every file under workspace/evidence/.',
        '   Those seeded files are immutable, read-only inputs. Never edit, delete, rename,',
        '   or overwrite anything under workspace/evidence/. Only postmortem.md may be changed.',
        '2. Write postmortem.md at the workspace root with these sections IN ORDER:',
        '   ## Summary (≤ 4 sentences, executive-readable),',
        '   ## Impact, ## Timeline, ## Root cause, ## Contributing factors,',
        '   ## What went well (≥ 2 specifics), ## What went poorly (≥ 2 specifics),',
        '   ## Action items as a markdown table: | Action | Owner | Due | Evidence |.',
        '   Include at least 3 action rows. A personal Owner must be grounded in the',
        '   evidence (Mira Chen, Bertha Vargas, Phil Okeke, or Anita Sayed); a concrete',
        '   handle or specific functional team is also allowed. Slash-separated',
        '   co-owners are allowed only when every component is concrete. Do not invent',
        '   personal names. Blank/vague values such as TBD, Team, Owner, Unknown, or',
        '   Unassigned do not count.',
        '3. After the fifth evidence file has been read, the next tool call must write postmortem.md.',
        '4. Cite evidence files inline by name (e.g. "deploy.log:14:32 UTC").',
        '5. Include at least 5 distinct evidence-file citations across the doc.',
        '6. Include at least 3 `HH:MM` timestamp citations.',
        '7. Tone: blame-free, factual, specific. Do NOT invent facts not in the evidence.',
        '   Treat impact categories the evidence does not measure as unknown; in particular,',
        '   do not assert that data loss or a security/privacy breach did or did not occur.',
        '8. Length: 6 KB to 30 KB.',
      ].join(' '),
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('incident-postmortem setup: failed to resolve project id');

  for (const f of INCIDENT_EVIDENCE_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(
    `[scenario:setup] seeded ${INCIDENT_EVIDENCE_FILES.length} evidence files under project ${projectId}`,
  );

  // No hand-written about: the service resolves the shipped Researcher
  // template (product-shaped prompt). Task specifics live in the kickoff
  // message below — the eval measures the product configuration, not a
  // scenario-tuned system prompt.
  const jordan = await provisionScenarioGezel(ctx, {
    preferredName: SRE_NAME,
    role: 'Researcher',
    label: 'SRE',
  });
  await client.addGezelToProject(projectId, jordan.id);
  log(`[scenario:setup] joined ${jordan.name} to project ${projectId}`);

  await client.sendChatMessage(jordan.id, {
    message: [
      'Please write the postmortem for the 2026-03-14 checkout-api incident. The',
      'evidence files are in workspace/evidence/ — five files: timeline.md,',
      'metrics.csv, deploy.log, oncall-chat.txt, hotfix.diff. Read all five first',
      '(use read_file with paths relative to the workspace root — no leading',
      '"workspace/"). Treat every file under evidence/ as immutable read-only input:',
      'do not edit, delete, rename, append to, or overwrite those files. The only file',
      'you may mutate is postmortem.md. Then write',
      'postmortem.md at the workspace root. Do NOT invent facts that are not in',
      'the evidence. Treat unmeasured outcomes as unknown: do not assert that data',
      'loss or a security/privacy breach did or did not occur. Required sections, in order: Summary,',
      'Impact, Timeline, Root cause, Contributing factors, What went well, What',
      'went poorly, Action items. In Action items, use a markdown table with',
      '`| Action | Owner | Due | Evidence |` and at least 3 action rows with',
      'an evidence-grounded person (Mira Chen, Bertha Vargas, Phil Okeke, or',
      'Anita Sayed), a concrete handle, or a specific functional team in every',
      'Owner cell. Slash-separated co-owners are allowed only when every component',
      'is concrete. Do not invent personal names. Blank/vague values such as TBD,',
      'Team, Owner, Unknown, or Unassigned do not count.',
      'Cite evidence files by name inline (e.g.',
      '"deploy.log:14:32"). At least 5 distinct citations, at least 3 `HH:MM`',
      'timestamps, 6-30 KB total, blame-free tone. After the fifth evidence read',
      'succeeds, your next tool call must be `write_file({ path: "postmortem.md",',
      'content: ... })`. Do not draft in chat or wait for a perfect final version;',
      'write a complete first pass, then patch it if needed.',
    ].join(' '),
    projectId,
  });
  log(`[scenario:setup] sent kickoff message to ${jordan.name} in project ${projectId}`);
}

/** Public so the --llm-judge bin can pass it through. */
export const incidentPostmortemJudgeContext = JUDGE_CONTEXT_NOTE;

export const incidentPostmortemScenario: EvalScenario = {
  id: 'incident-postmortem',
  description:
    'Read 5 immutable evidence files (timeline.md, metrics.csv, deploy.log, oncall-chat.txt, hotfix.diff) without modifying them, and write a grounded SRE postmortem at workspace/postmortem.md with 8 canonical sections in order, ≥5 distinct evidence citations, ≥3 timestamp citations, critical facts consistent with the pack, no confident claims about unmeasured impact, and blame-free tone.',
  prompt: [
    `Heads up: ${SRE_NAME} is writing a postmortem on the "${PROJECT_NAME}" project.`,
    "The evidence pack is seeded under that project's workspace/evidence/.",
    "You don't need to do anything — just confirm you've seen this note.",
  ].join(' '),
  skipInitialPrompt: true,
  timeoutMs: 40 * 60_000,
  // Postmortems are write-heavy with long thinking phases between
  // sections. 15 min between progress events absorbs super-120b's
  // first-turn warmup; smaller models deliver turns well under this.
  progressTimeoutMs: 15 * 60_000,
  setup,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] incident-postmortem project not present yet');
      return { done: false };
    }
    const persistedEvidence = new Map<string, string | null>(
      await Promise.all(
        INCIDENT_EVIDENCE_FILES.map(
          async (fixture) =>
            [fixture.path, await readWorkspaceText(client, projectId, fixture.path)] as const,
        ),
      ),
    );
    const evidenceIntegrity = checkSeedFixtureIntegrity(INCIDENT_EVIDENCE_FILES, persistedEvidence);
    const postmortem = await readWorkspaceText(client, projectId, 'postmortem.md');
    if (postmortem === null) {
      if (!evidenceIntegrity.ok) {
        const integrityFailure = describeSeedFixtureIntegrityFailure(evidenceIntegrity);
        logChanged(
          'evidence-integrity',
          `[scenario] incident-postmortem evidence-integrity FAIL ${integrityFailure}`,
        );
        return {
          done: true,
          success: false,
          failureMode: 'success-check-false',
          reason: `evidence-integrity: ${integrityFailure}`,
        };
      }
      logChanged('sniff', '[scenario] postmortem.md not present yet');
      recordSniff?.({ key: 'incident-postmortem', score: 0, bytes: 0 });
      // Read-then-never-write stall: once the Researcher has had time to
      // read the 5 evidence files, directive-nudge it to actually write
      // postmortem.md (the qwen3.5 trials read 10 files then
      // stalled at rp0:rf0 without ever calling write_file).
      await postMissingDeliverableFeedback(ctx, 'postmortem.md', {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 1,
      });
      return { done: false };
    }

    const bytes = postmortem.length;
    const verdict = evaluateIncidentPostmortem(postmortem, persistedEvidence);
    const { signals, score, failReason, failures } = verdict;
    logChanged(
      'sniff',
      `[scenario] incident-postmortem bytes=${bytes} score=${score}/9 signals=${signals.join(',') || 'none'}${failReason ? ` failReason="${failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'incident-postmortem',
      score,
      bytes,
      ...(failReason ? { failReason } : {}),
    });

    // Seeded evidence is immutable input. A model that modifies or deletes a
    // source has invalidated the evidence-synthesis task; do not ask it to
    // repair the report or to reconstruct the source from remembered values.
    if (!verdict.evidenceIntegrity.ok) {
      const integrityFailure = describeSeedFixtureIntegrityFailure(verdict.evidenceIntegrity);
      logChanged(
        'evidence-integrity',
        `[scenario] incident-postmortem evidence-integrity FAIL ${integrityFailure}`,
      );
      return {
        done: true,
        success: false,
        failureMode: 'success-check-false',
        reason: `evidence-integrity: ${integrityFailure}`,
      };
    }

    // Pass when all 8 hard signals fire. `no-blame-language` is
    // soft (we just record it). The judge layer (when --llm-judge ran)
    // contributes its own advisory axes via the report.
    if (verdict.success) {
      return {
        done: true,
        success: true,
        reason: `all 8 hard signals firing (signals: ${signals.join(', ')})`,
      };
    }

    // Forward concrete failures back into team chat — without this the
    // model writes once, gets no feedback, and stalls. Wild-caught
    // qwen3.6 trial: model wrote a publishable postmortem
    // missing one signal, never iterated, fell into soft-timeout.
    if (failReason) {
      const allHardSignals = [
        'file-present',
        'all-sections',
        'summary-concise',
        'evidence-citations',
        'timestamp-citations',
        'grounded-core-facts',
        'no-unsupported-certainty',
        'action-items-formatted',
      ];
      const missing = allHardSignals.filter((s) => !signals.includes(s));
      await postSniffFeedback(
        ctx,
        'postmortem.md',
        {
          ok: false,
          signals,
          score,
          failReason,
          missingRequiredSignals: missing,
        },
        {
          repairDirective: incidentRepairDirective(
            failReason,
            bytes,
            missing,
            postmortem,
            failures,
          ),
          targetedEditsOnly: true,
        },
      );
    }
    return { done: false };
  },
};
