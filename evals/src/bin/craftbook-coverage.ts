import { auditCraftbookTemplates, validateCraftbookEvalSpecs } from '../craftbooks/audit.ts';
import { findBoilerplateEvalSpecs } from '../craftbooks/boilerplate.ts';
import { loadCraftbookTemplates } from '../craftbooks/catalog.ts';
import { auditDeliverableReachability } from '../craftbooks/deliverable-reachability.ts';
import { CRAFTBOOK_EVAL_SPECS } from '../craftbooks/specs.ts';

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const json = hasFlag('--json');
  const strict = hasFlag('--strict');
  const limit = Number(flagValue('--limit') ?? '20');
  const templates = await loadCraftbookTemplates();
  const specErrors = validateCraftbookEvalSpecs(templates);
  const { audits, summary } = auditCraftbookTemplates(templates);
  const boilerplate = findBoilerplateEvalSpecs(CRAFTBOOK_EVAL_SPECS);
  const boilerplateValidated = boilerplate.filter((b) => b.coverageStatus === 'validated');
  const reach = auditDeliverableReachability(CRAFTBOOK_EVAL_SPECS, templates);

  if (json) {
    console.log(
      JSON.stringify({ summary, specErrors, boilerplate, reachability: reach, audits }, null, 2),
    );
  } else {
    console.log('Craftbook eval coverage');
    console.log(`  templates:        ${summary.totalTemplates}`);
    console.log(`  eval specs:       ${summary.evalSpecs}`);
    console.log(`  implemented:      ${summary.implementedSpecs}`);
    console.log(`  validated:        ${summary.validatedSpecs}`);
    console.log('  eval mode:');
    console.log(`    workflow:       ${summary.workflowSpecs}`);
    console.log(`    artifact-task:  ${summary.artifactTaskSpecs}`);
    console.log('  validated proof:');
    console.log(`    workflow:       ${summary.workflowValidatedSpecs}`);
    console.log(`    artifact-only:  ${summary.artifactOnlyValidatedSpecs}`);
    console.log(`  avg quality:      ${summary.averageQualityScore}/110`);
    console.log(
      `  bands:            strong=${summary.byBand.strong} needs-work=${summary.byBand['needs-work']} weak=${summary.byBand.weak}`,
    );
    console.log(
      `  eval status:      validated=${summary.byEvalStatus.validated} implemented=${summary.byEvalStatus.implemented} planned=${summary.byEvalStatus.planned} missing=${summary.byEvalStatus.missing}`,
    );
    // Read this NEXT TO `validated`, not after it. A boilerplate spec shares
    // its kickoff prompt with other books and has no gate that looks for its
    // own subject, so its pass says the family smoke test works — not that
    // this book does. Counting those as validated is what hid the gap.
    console.log(
      `  family boilerplate: ${boilerplate.length} spec(s) cannot distinguish their book from the others sharing their prompt`,
    );
    console.log(
      `    of which recorded validated: ${boilerplateValidated.length}  ` +
        `(effective book-specific validated: ${summary.byEvalStatus.validated - boilerplateValidated.length})`,
    );
    // The load-bearing number. An `unreachable` spec grades a path the book
    // never writes, so following the craftbook FAILS the eval while ignoring it
    // and writing the placeholder PASSES — the eval is inverted, not merely
    // absent. `folder-drift` is the same defect with a one-line repair.
    console.log(
      `  deliverable reachability: reachable=${reach.reachable} folder-drift=${reach.folderDrift} unreachable=${reach.unreachable} (of ${reach.checked})`,
    );
    if (reach.unreachable > 0) {
      const shown = reach.findings
        .filter((f) => f.verdict === 'unreachable')
        .slice(0, Number.isFinite(limit) ? limit : 20);
      console.log(
        `\n  evals grading a path their craftbook never writes (${shown.length} of ${reach.unreachable})`,
      );
      for (const f of shown) {
        console.log(
          `    ${f.craftbookId.padEnd(30)} grades ${f.paths.join(', ')} — book writes ${f.bookGatedPaths.slice(0, 3).join(', ') || '(nothing gated)'}`,
        );
      }
    }
    if (boilerplate.length > 0) {
      const shown = boilerplate.slice(0, Number.isFinite(limit) ? limit : 20);
      console.log(`\n  boilerplate specs (${shown.length} of ${boilerplate.length})`);
      for (const b of shown) {
        console.log(
          `    ${b.craftbookId.padEnd(30)} ${b.coverageStatus.padEnd(11)} prompt shared with ${String(b.sharedWith.length - 1).padStart(2)} other book(s); no gate mentions ${b.unmatchedSubjectTerms.join('/')}`,
        );
      }
    }
    if (specErrors.length > 0) {
      console.log('\nSpec errors');
      for (const error of specErrors) console.log(`  - ${error}`);
    }

    const prioritized = audits
      .filter((audit) => audit.issues.some((issue) => issue.severity !== 'info'))
      .sort((a, b) => a.score - b.score || a.craftbookId.localeCompare(b.craftbookId))
      .slice(0, Number.isFinite(limit) ? limit : 20);
    console.log(`\nLowest-scoring templates (${prioritized.length})`);
    for (const audit of prioritized) {
      const lead = audit.issues.find((issue) => issue.severity !== 'info');
      console.log(
        `  ${audit.craftbookId.padEnd(28)} ${String(audit.score).padStart(3)}/110 ${audit.band.padEnd(10)} eval=${audit.evalStatus}/${audit.evalMode}/${audit.validationScope}${lead ? `  ${lead.code}: ${lead.message}` : ''}`,
      );
    }
  }

  if (strict && (specErrors.length > 0 || summary.byEvalStatus.missing > 0)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[craftbook-coverage] fatal:', err);
  process.exit(2);
});
