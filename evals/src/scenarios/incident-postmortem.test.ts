import { describe, expect, it, vi } from 'vitest';

import {
  INCIDENT_EVIDENCE_FILES,
  evaluateIncidentPostmortem,
  incidentPostmortemScenario,
  incidentRepairDirective,
} from './incident-postmortem.ts';

const evidenceAnalysis = Array.from(
  { length: 28 },
  (_, index) =>
    `Evidence note ${index + 1}: metrics.csv records the error rise at 14:33 after deploy.log records v4.18.0 completing at 14:32. oncall-chat.txt ties the 99% connection-pool saturation to the longer timeout, while timeline.md and hotfix.diff corroborate the response and revert. This note stays within the supplied record and adds no unsupported impact claim.`,
).join('\n\n');

const GROUNDED_REFERENCE = `# Checkout Incident Postmortem

## Summary

PR #3094 changed the PaymentGateway client timeout from 800ms to 8000ms in checkout-api v4.18.0. The 14:32 deploy was followed by the 14:33 error and p99 latency spike as the connection pool saturated. Bertha Vargas led the first response, and Mira Chen served as incident commander. The v4.18.1 hotfix reverted the change and service recovered by 14:54.

## Impact

metrics.csv shows the error rate reaching 13.1% and connection-pool saturation reaching 99%. The supplied evidence does not establish whether data loss or any security/privacy impact occurred.

## Timeline

- 14:32: deploy 8147 completed, according to deploy.log and timeline.md.
- 14:33: metrics.csv recorded the first error and p99 latency spike.
- 14:34: PagerDuty paged the on-call rotation in oncall-chat.txt.
- 14:41: Mira Chen took IC and incident command.
- 14:53: deploy 8155 shipped v4.18.1.
- 14:54: error rate recovered below 1% and latency returned to baseline.

## Root cause

PR #3094 raised the PaymentGateway timeout from 800ms to 8000ms. Under steady load, the longer wait held connections until the connection pool reached 99% saturation and exhausted available capacity (metrics.csv; oncall-chat.txt). hotfix.diff confirms that the mitigation restored the timeout to 800ms.

## Contributing factors

The change was tested on canary but not under sustained load, so the capacity effect was not measured before rollout (timeline.md; oncall-chat.txt).

${evidenceAnalysis}

## What went well

Bertha Vargas connected the 14:33 symptoms to the deploy and connection-pool mechanism quickly. Mira Chen established incident command, and the team delivered the v4.18.1/8155 revert before verifying recovery at 14:54.

## What went poorly

The review and canary process did not include a sustained-load check for the timeout change. Saturation was observed only after the user-facing error signal fired.

## Action items

| Action | Owner | Due | Evidence |
|---|---|---|---|
| Add steady-state load coverage for timeout changes | Platform Team | 2026-03-28 | timeline.md; oncall-chat.txt |
| Alert on connection-pool saturation before 99% | SRE Team | 2026-03-21 | metrics.csv |
| Add resource-impact review guidance | Release Engineering | 2026-04-04 | deploy.log; hotfix.diff |
`;

const FROZEN_NAMED_OWNER_ACTIONS = `## Action items

| Action | Owner | Due | Evidence |
| :--- | :--- | :--- | :--- |
| Implement stricter load testing that includes timeout-induced connection pool saturation scenarios. | Phil Okeke | TBD | oncall-chat.txt:14 |
| Mandate a formal peer review checklist item specifically for changes that alter external service timeouts, including resource implications. | Mira Chen | TBD | timeline.md:34 |
| Automate a canary deployment that monitors connection pool saturation metrics before rolling to 100%. | Bertha Vargas | TBD | metrics.csv:10 |
`;

const FROZEN_COMPOSITE_OWNER_ACTIONS = `## Action items

| Action | Owner | Due | Evidence |
| :--- | :--- | :--- | :--- |
| Add steady-state load tests for timeout changes. | Phil Okeke / QA Team | 2026-03-28 | oncall-chat.txt:14 |
| Add resource-impact review guidance. | Anita Sayed / Engineering Mgmt | 2026-04-04 | timeline.md:41-42 |
| Alert on connection-pool saturation. | Mira Chen / SRE Team | 2026-03-21 | metrics.csv:10 |
`;

const FROZEN_INVENTED_OWNER_ACTIONS = `## Action items

| Action | Owner | Due | Evidence |
| :--- | :--- | :--- | :--- |
| Review payment gateway timeout logic in all services. | Jordan (SRE) | 2026-04-15 | deploy.log:14:32 UTC |
| Update connection pool sizing parameters for checkout-api. | Sarah Chen (Platform Eng) | 2026-04-15 | metrics.csv: line 48 |
| Implement automated rollback triggers. | Checkout Team | 2026-04-30 | timeline.md: 14:50 UTC |
`;

const FROZEN_FALSE_PASS_CLAIMS = `

### Detailed Incident Analysis and Recovery

The p99 latency metric showed extreme saturation, spiking to over 99% of its maximum observed value (metrics.csv). This saturation was a direct consequence of the longer PaymentGateway timeout. The system was effectively unable to process new requests because existing connections were tied up waiting for slow external responses.

### Further Remediation and Process Improvements

The reliance on a single service timeout value across the entire checkout flow, as seen in hotfix.diff, suggests a lack of granular configuration management for external dependencies.
`;

function replaceActionItems(postmortem: string, actionItems: string): string {
  return postmortem.replace(/## Action items[\s\S]*$/, actionItems);
}

function intactIncidentEvidence(): Map<string, string> {
  return new Map(INCIDENT_EVIDENCE_FILES.map((fixture) => [fixture.path, fixture.content]));
}

describe('incident-postmortem objective grounding gate', () => {
  it('repairs a size-only miss by appending with headroom instead of rewriting passing sections', () => {
    const directive = incidentRepairDirective(
      'postmortem.md is 5922B (need ≥ 6 KB)',
      5922,
      ['file-present'],
      '# existing postmortem',
    );

    expect(directive).toContain('appendToFile');
    expect(directive).toContain('clears 7 KiB with headroom');
    expect(directive).toContain('at least 1500 substantive characters');
    expect(directive).toContain('Do not call `writeFile`');
  });

  it('combines length, grounding, and action repairs instead of starving later failures', () => {
    const underSizedNearMiss = `# Checkout Incident

## Impact

metrics.csv shows a 9.1% error rate.

${FROZEN_NAMED_OWNER_ACTIONS.replaceAll('Phil Okeke', 'TBD')}`;
    const failures = [
      'postmortem.md is 4947B (need ≥ 6 KB)',
      'grounded-core-facts: missing 13% error peak and 99% saturation impact; Bertha Vargas first response and Mira Chen incident command',
      'action-items-formatted: 3 items (0 list + 3 table rows), 0 with concrete owner',
    ];
    const directive = incidentRepairDirective(
      failures[0] ?? '',
      4947,
      ['file-present', 'grounded-core-facts', 'action-items-formatted'],
      underSizedNearMiss,
      failures,
    );

    expect(directive).toContain('INCIDENT POSTMORTEM COMBINED PATCH');
    expect(directive).toContain(failures.join(' | '));
    expect(directive).toContain('`replaceInFile`');
    expect(directive).toContain('`appendToFile`');
    expect(directive).toContain('at least 2221 substantive evidence-backed characters');
    expect(directive).toContain('13% error peak and 99% saturation impact');
    expect(directive).toContain('Bertha Vargas first response and Mira Chen incident command');
    expect(directive).toContain('Complete every numbered file edit before replying');
    expect(directive).toContain('Do not call `writeFile`');
  });

  it('passes a substantive reference that recovers the critical evidence-pack facts', () => {
    const verdict = evaluateIncidentPostmortem(GROUNDED_REFERENCE, intactIncidentEvidence());

    expect(GROUNDED_REFERENCE.length).toBeGreaterThanOrEqual(6 * 1024);
    expect(GROUNDED_REFERENCE.length).toBeLessThanOrEqual(30 * 1024);
    expect(verdict.failures).toEqual([]);
    expect(verdict.signals).toEqual(
      expect.arrayContaining([
        'grounded-core-facts',
        'no-unsupported-certainty',
        'no-blame-language',
      ]),
    );
    expect(verdict.hardSignals).toHaveLength(8);
    expect(verdict.score).toBe(9);
    expect(verdict.evidenceIntegrity).toEqual({
      ok: true,
      missingPaths: [],
      modifiedPaths: [],
    });
    expect(verdict.success).toBe(true);
  });

  it('rejects the exact frozen hotfix.diff mutation from -8000/+800 to -800/+800', () => {
    const evidence = intactIncidentEvidence();
    const path = 'evidence/hotfix.diff';
    const original = evidence.get(path) ?? '';
    const frozenMutation = original.replace('-      timeout: 8000,', '-      timeout: 800,');
    expect(frozenMutation).not.toBe(original);
    evidence.set(path, frozenMutation);

    const verdict = evaluateIncidentPostmortem(GROUNDED_REFERENCE, evidence);

    expect(verdict.evidenceIntegrity).toEqual({
      ok: false,
      missingPaths: [],
      modifiedPaths: [path],
    });
    expect(verdict.signals).not.toContain('grounded-core-facts');
    expect(verdict.failures).toContain(
      'grounded-core-facts: evidence-integrity: modified seeded source(s): evidence/hotfix.diff',
    );
    expect(verdict.hardSignals).toHaveLength(7);
    expect(verdict.score).toBe(8);
    expect(verdict.success).toBe(false);
  });

  it('rejects deletion of any seeded evidence source', () => {
    const evidence = intactIncidentEvidence();
    evidence.delete('evidence/hotfix.diff');

    const verdict = evaluateIncidentPostmortem(GROUNDED_REFERENCE, evidence);

    expect(verdict.evidenceIntegrity).toEqual({
      ok: false,
      missingPaths: ['evidence/hotfix.diff'],
      modifiedPaths: [],
    });
    expect(verdict.signals).not.toContain('grounded-core-facts');
    expect(verdict.failReason).toContain(
      'evidence-integrity: missing seeded source(s): evidence/hotfix.diff',
    );
    expect(verdict.success).toBe(false);
  });

  it('rejects exact-content tampering in a different seeded source', () => {
    const evidence = intactIncidentEvidence();
    const path = 'evidence/timeline.md';
    evidence.set(path, `${evidence.get(path)}\n`);

    const verdict = evaluateIncidentPostmortem(GROUNDED_REFERENCE, evidence);

    expect(verdict.evidenceIntegrity).toEqual({
      ok: false,
      missingPaths: [],
      modifiedPaths: [path],
    });
    expect(verdict.signals).not.toContain('grounded-core-facts');
    expect(verdict.failReason).toContain(
      'evidence-integrity: modified seeded source(s): evidence/timeline.md',
    );
    expect(verdict.success).toBe(false);
  });

  it('terminal-fails the live success check instead of asking the model to repair tampered evidence', async () => {
    const evidence = intactIncidentEvidence();
    const hotfixPath = 'evidence/hotfix.diff';
    evidence.set(
      hotfixPath,
      (evidence.get(hotfixPath) ?? '').replace('-      timeout: 8000,', '-      timeout: 800,'),
    );
    const workspace = new Map<string, string>([...evidence, ['postmortem.md', GROUNDED_REFERENCE]]);
    const logChanged = vi.fn();
    const recordSniff = vi.fn();
    const client = {
      listProjects: vi.fn(async () => ({
        projects: [{ id: 'checkout-incident-postmortem', name: 'Checkout Incident Postmortem' }],
      })),
      fetchProjectWorkspaceBlob: vi.fn(async (_projectId: string, path: string) => {
        const content = workspace.get(path);
        if (content === undefined) throw new Error(`not found: ${path}`);
        return new Blob([content]);
      }),
    };

    const result = await incidentPostmortemScenario.successCheck({
      client,
      meesterId: 'soren',
      log: vi.fn(),
      logChanged,
      recordSniff,
    } as never);

    expect(result).toEqual({
      done: true,
      success: false,
      failureMode: 'success-check-false',
      reason: 'evidence-integrity: modified seeded source(s): evidence/hotfix.diff',
    });
    expect(recordSniff).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'incident-postmortem',
        score: 8,
        failReason: expect.stringContaining('modified seeded source(s): evidence/hotfix.diff'),
      }),
    );
    expect(logChanged).toHaveBeenCalledWith(
      'evidence-integrity',
      expect.stringContaining('modified seeded source(s): evidence/hotfix.diff'),
    );
  });

  it('credits the frozen 14:54 recovery wording that ends in below 1%', () => {
    const frozenRecoveryVariant = GROUNDED_REFERENCE.replace(
      'The v4.18.1 hotfix reverted the change and service recovered by 14:54.',
      'The v4.18.1 hotfix reverted the change.',
    )
      .replace(
        '- 14:54: error rate recovered below 1% and latency returned to baseline.',
        '- **14:54** - The hotfix successfully restored service health, with error rate dropping below 1% (`metrics.csv:31`).',
      )
      .replace(
        'the team delivered the v4.18.1/8155 revert before verifying recovery at 14:54.',
        'the team delivered the v4.18.1/8155 revert during mitigation.',
      );
    const verdict = evaluateIncidentPostmortem(frozenRecoveryVariant);

    expect(verdict.signals).toContain('grounded-core-facts');
    expect(
      verdict.failures.find((failure) => failure.includes('recovery by 14:54')),
    ).toBeUndefined();
    expect(verdict.success).toBe(true);
  });

  it('credits the frozen trial action table when Owner cells contain concrete personal DRIs', () => {
    const frozenNamedOwnerVariant = replaceActionItems(
      GROUNDED_REFERENCE,
      FROZEN_NAMED_OWNER_ACTIONS,
    );
    const verdict = evaluateIncidentPostmortem(frozenNamedOwnerVariant);

    expect(verdict.signals).toContain('action-items-formatted');
    expect(
      verdict.failures.find((failure) => failure.startsWith('action-items-formatted')),
    ).toBeUndefined();
    expect(verdict.success).toBe(true);
  });

  it('credits grounded slash-composite people and specific teams from the frozen trial', () => {
    const verdict = evaluateIncidentPostmortem(
      replaceActionItems(GROUNDED_REFERENCE, FROZEN_COMPOSITE_OWNER_ACTIONS),
    );

    expect(verdict.signals).toContain('action-items-formatted');
    expect(
      verdict.failures.find((failure) => failure.startsWith('action-items-formatted')),
    ).toBeUndefined();
    expect(verdict.success).toBe(true);
  });

  it('rejects the frozen invented Jordan/Sarah owners while retaining the specific team', () => {
    const verdict = evaluateIncidentPostmortem(
      replaceActionItems(GROUNDED_REFERENCE, FROZEN_INVENTED_OWNER_ACTIONS),
    );
    const actionFailure = verdict.failures.find((failure) =>
      failure.startsWith('action-items-formatted'),
    );

    expect(verdict.signals).not.toContain('action-items-formatted');
    expect(actionFailure).toContain('1 with concrete owner');
    expect(actionFailure).toContain('"Jordan (SRE)"');
    expect(actionFailure).toContain('"Sarah Chen (Platform Eng)"');
    expect(actionFailure).not.toContain('"Checkout Team"');
    expect(verdict.success).toBe(false);
  });

  it('does not let a valid co-owner team launder an invented personal name', () => {
    const inventedComposite = FROZEN_COMPOSITE_OWNER_ACTIONS.replace(
      'Phil Okeke / QA Team',
      'Sarah Chen / QA Team',
    );
    const verdict = evaluateIncidentPostmortem(
      replaceActionItems(GROUNDED_REFERENCE, inventedComposite),
    );

    expect(verdict.signals).not.toContain('action-items-formatted');
    expect(
      verdict.failures.find((failure) => failure.startsWith('action-items-formatted')),
    ).toContain('2 with concrete owner');
  });

  it('continues to allow concrete handles and specific functional teams', () => {
    const handlesAndTeams = `## Action items

| Action | Owner | Due | Evidence |
|---|---|---|---|
| Coordinate the rollback drill | @checkout-oncall | 2026-03-28 | timeline.md |
| Validate responder guidance | bertha.vargas | 2026-03-21 | oncall-chat.txt |
| Add sustained-load coverage | Platform/SRE team | 2026-04-04 | hotfix.diff |
`;
    const verdict = evaluateIncidentPostmortem(
      replaceActionItems(GROUNDED_REFERENCE, handlesAndTeams),
    );

    expect(verdict.signals).toContain('action-items-formatted');
    expect(verdict.success).toBe(true);
  });

  it('rejects empty or vague Owner cells even when other table cells contain team words', () => {
    const vagueOwners = `## Action items

| Action | Owner | Due | Evidence |
|---|---|---|---|
| Have the SRE team add a steady-state load test |  | 2026-03-28 | timeline.md |
| Ask platform to alert before pool saturation | TBD | 2026-03-21 | metrics.csv |
| Require release engineering review | Team | 2026-04-04 | deploy.log |
`;
    const verdict = evaluateIncidentPostmortem(replaceActionItems(GROUNDED_REFERENCE, vagueOwners));
    const actionFailure = verdict.failures.find((failure) =>
      failure.startsWith('action-items-formatted'),
    );

    expect(verdict.signals).not.toContain('action-items-formatted');
    expect(actionFailure).toContain('3 table rows');
    expect(actionFailure).toContain('0 with concrete owner');
    expect(actionFailure).toContain('"<empty>"');
    expect(actionFailure).toContain('"TBD"');
    expect(actionFailure).toContain('"Team"');
    expect(verdict.success).toBe(false);
  });

  it('requires every action row to have a concrete DRI, matching the prompt contract', () => {
    const oneVagueOwner = FROZEN_NAMED_OWNER_ACTIONS.replace('Bertha Vargas', 'Unassigned');
    const verdict = evaluateIncidentPostmortem(
      replaceActionItems(GROUNDED_REFERENCE, oneVagueOwner),
    );

    expect(verdict.signals).not.toContain('action-items-formatted');
    expect(
      verdict.failures.find((failure) => failure.startsWith('action-items-formatted')),
    ).toContain('2 with concrete owner');
  });

  it('fails the observed near-miss that invents a no-data-loss/security conclusion', () => {
    const nearMiss = GROUNDED_REFERENCE.replace(
      'The supplied evidence does not establish whether data loss or any security/privacy impact occurred.',
      'There was no data loss or security breach.',
    );
    const verdict = evaluateIncidentPostmortem(nearMiss);

    expect(verdict.signals).toContain('grounded-core-facts');
    expect(verdict.signals).not.toContain('no-unsupported-certainty');
    expect(verdict.failReason).toContain('no-unsupported-certainty');
    expect(verdict.failReason).toContain('no data loss');
    expect(verdict.success).toBe(false);
  });

  it('allows supported metric separation, partial-impact wording, and configuration audits', () => {
    const supportedParaphrases = GROUNDED_REFERENCE.replace(
      'metrics.csv shows the error rate reaching 13.1% and connection-pool saturation reaching 99%.',
      [
        'metrics.csv shows the error rate reaching 13.1%.',
        'P99 latency reached 5.18 seconds while connection-pool saturation reached 99%.',
        'The checkout service was degraded; the supplied evidence does not establish that it was completely unable to process new requests.',
        'hotfix.diff shows the PaymentGateway client timeout. Audit whether other checkout dependencies use shared or per-client timeout configuration.',
      ].join(' '),
    );
    const verdict = evaluateIncidentPostmortem(supportedParaphrases);

    expect(verdict.signals).toContain('no-unsupported-certainty');
    expect(
      verdict.failures.find((failure) => failure.startsWith('no-unsupported-certainty')),
    ).toBeUndefined();
    expect(verdict.success).toBe(true);
  });

  it('rejects assigning the pool-saturation percentage to p99/latency', () => {
    const conflatedMetrics = `${GROUNDED_REFERENCE}\n\nThe p99 latency metric itself saturated, spiking to 99% of its maximum observed value.`;
    const verdict = evaluateIncidentPostmortem(conflatedMetrics);
    const groundingFailure = verdict.failures.find((failure) =>
      failure.startsWith('no-unsupported-certainty'),
    );

    expect(verdict.signals).not.toContain('no-unsupported-certainty');
    expect(groundingFailure).toContain(
      'unsupported metric relationship: assigns the percentage saturation value to p99/latency',
    );
    expect(verdict.success).toBe(false);
  });

  it('rejects upgrading a measured partial error rate to total processing inability', () => {
    const totalOutage = `${GROUNDED_REFERENCE}\n\nThe checkout-api was completely unable to process new requests during the incident.`;
    const verdict = evaluateIncidentPostmortem(totalOutage);
    const groundingFailure = verdict.failures.find((failure) =>
      failure.startsWith('no-unsupported-certainty'),
    );

    expect(verdict.signals).not.toContain('no-unsupported-certainty');
    expect(groundingFailure).toContain(
      'unsupported total-unavailability claim: says the service could not process new requests',
    );
    expect(verdict.success).toBe(false);
  });

  it('rejects extrapolating one client timeout into whole-flow configuration topology', () => {
    const wholeFlowInference = `${GROUNDED_REFERENCE}\n\nAll checkout dependencies use the same timeout, proving a lack of granular configuration management.`;
    const verdict = evaluateIncidentPostmortem(wholeFlowInference);
    const groundingFailure = verdict.failures.find((failure) =>
      failure.startsWith('no-unsupported-certainty'),
    );

    expect(verdict.signals).not.toContain('no-unsupported-certainty');
    expect(groundingFailure).toContain(
      'unsupported configuration-scope inference: generalizes one client timeout to the whole checkout flow or asserts missing granularity',
    );
    expect(verdict.success).toBe(false);
  });

  it('downgrades the frozen 9/9 artifact claims with all three focused diagnostics', () => {
    const frozenFalsePass = `${GROUNDED_REFERENCE}${FROZEN_FALSE_PASS_CLAIMS}`;
    const verdict = evaluateIncidentPostmortem(frozenFalsePass);
    const groundingFailure = verdict.failures.find((failure) =>
      failure.startsWith('no-unsupported-certainty'),
    );

    expect(verdict.signals).not.toContain('no-unsupported-certainty');
    expect(groundingFailure).toContain('unsupported metric relationship');
    expect(groundingFailure).toContain('unsupported total-unavailability claim');
    expect(groundingFailure).toContain('unsupported configuration-scope inference');
    expect(verdict.hardSignals).toHaveLength(7);
    expect(verdict.score).toBe(8);
    expect(verdict.success).toBe(false);

    const directive = incidentRepairDirective(
      groundingFailure ?? '',
      frozenFalsePass.length,
      ['no-unsupported-certainty'],
      frozenFalsePass,
      verdict.failures,
    );
    expect(directive).toContain('Keep metric relationships exact');
    expect(directive).toContain('partial request failure');
    expect(directive).toContain('not whole-checkout configuration topology');
  });

  it('does not award grounding for the right tokens attached to inverted facts', () => {
    const tokenBagNearMiss = `
      PR #3094 changed the PaymentGateway timeout from 8000ms to 800ms.
      A connection pool saturation mechanism was discussed.
      At 14:32 the error and p99 latency spike began; the deploy followed at 14:33.
      Saturation peaked at 13.1%, while the error rate reached 99%.
      Mira Chen led the first response and Bertha Vargas served as IC.
      The v4.18.1 hotfix/revert recovered service at 14:40. A meeting happened at 14:54.
    `;

    const verdict = evaluateIncidentPostmortem(tokenBagNearMiss);

    expect(verdict.signals).not.toContain('grounded-core-facts');
    expect(verdict.failures.find((failure) => failure.startsWith('grounded-core-facts'))).toContain(
      'PR #3094 timeout change from 800ms to 8000ms',
    );
  });
});
