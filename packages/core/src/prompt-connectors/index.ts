/**
 * What in a draft a connector could serve. A rule reads the person's words
 * (today: the web addresses in them) and claims what its connector type
 * handles; the composer shows each claim before Send, and the daemon decides
 * which are still open (docs/prompt-connectors.md).
 *
 * To add a connector: write a rule, put it before the rules it is more
 * specific than, and register a resolver for its id in the service
 * (`prompt-connectors/service.ts`). A `github.com/<owner>/<repo>` rule placed
 * before `web-page` claims that address first, so it is offered as a GitHub
 * connection and never also as a page to save.
 */

import type { PromptConnectorEffect } from '../schemas/prompt-connectors.js';
import { findUrlsInText, pageLabel } from '../web-pages/url.js';

/** One thing a rule found in a draft. `rule` + `subject` identify it. */
export interface PromptConnectorCandidate {
  rule: string;
  connectorType: string;
  effect: PromptConnectorEffect;
  subject: string;
  label: string;
}

/** What a rule is shown: the words, and the addresses already found in them. */
export interface PromptConnectorDraft {
  text: string;
  /** Normalized web addresses in the order written. */
  urls: readonly string[];
}

export interface PromptConnectorRule {
  readonly id: string;
  /** Catalog connector type that serves what this rule finds. */
  readonly connectorType: string;
  readonly effect: PromptConnectorEffect;
  /** Everything this rule claims in the draft, in the order written. */
  find(draft: PromptConnectorDraft): { subject: string; label: string }[];
}

/** Any web address: the website connector saves the page. The catch-all, so it goes last. */
export const WEB_PAGE_RULE: PromptConnectorRule = {
  id: 'web-page',
  connectorType: 'website',
  effect: 'include',
  find: ({ urls }) => urls.map((url) => ({ subject: url, label: pageLabel(url) })),
};

/** Most specific first: a subject an earlier rule claimed is not offered by a later one. */
export const PROMPT_CONNECTOR_RULES: readonly PromptConnectorRule[] = [WEB_PAGE_RULE];

/** How many offers one draft shows. Send acts on each, so the person must be able to read them all. */
export const MAX_PROMPT_CONNECTOR_CANDIDATES = 3;

export function findPromptConnectorCandidates(
  text: string,
  opts: { rules?: readonly PromptConnectorRule[]; max?: number } = {},
): PromptConnectorCandidate[] {
  const rules = opts.rules ?? PROMPT_CONNECTOR_RULES;
  const max = opts.max ?? MAX_PROMPT_CONNECTOR_CANDIDATES;
  const draft: PromptConnectorDraft = { text, urls: findUrlsInText(text, 12) };
  const claimed = new Set<string>();
  const out: PromptConnectorCandidate[] = [];
  for (const rule of rules) {
    for (const found of rule.find(draft)) {
      if (claimed.has(found.subject)) continue;
      claimed.add(found.subject);
      out.push({
        rule: rule.id,
        connectorType: rule.connectorType,
        effect: rule.effect,
        subject: found.subject,
        label: found.label,
      });
    }
  }
  return out.slice(0, max);
}

/** The candidate a rule would make of one subject, or null when it claims nothing there. */
export function promptConnectorCandidateFor(
  ruleId: string,
  subject: string,
  rules: readonly PromptConnectorRule[] = PROMPT_CONNECTOR_RULES,
): PromptConnectorCandidate | null {
  return (
    findPromptConnectorCandidates(subject, { rules, max: 12 }).find(
      (c) => c.rule === ruleId && c.subject === subject,
    ) ?? null
  );
}

/** Stable identity of a candidate, for dismissals and keys. */
export function promptConnectorKey(c: Pick<PromptConnectorCandidate, 'rule' | 'subject'>): string {
  return `${c.rule}:${c.subject}`;
}
