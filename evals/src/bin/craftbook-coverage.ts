import { auditCraftbookTemplates, validateCraftbookEvalSpecs } from '../craftbooks/audit.ts';
import { loadCraftbookTemplates } from '../craftbooks/catalog.ts';

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

  if (json) {
    console.log(JSON.stringify({ summary, specErrors, audits }, null, 2));
  } else {
    console.log('Craftbook eval coverage');
    console.log(`  templates:        ${summary.totalTemplates}`);
    console.log(`  eval specs:       ${summary.evalSpecs}`);
    console.log(`  implemented:      ${summary.implementedSpecs}`);
    console.log(`  validated:        ${summary.validatedSpecs}`);
    console.log(`    workflow:       ${summary.workflowValidatedSpecs}`);
    console.log(`    artifact-only:  ${summary.artifactOnlyValidatedSpecs}`);
    console.log(`  avg quality:      ${summary.averageQualityScore}/110`);
    console.log(
      `  bands:            strong=${summary.byBand.strong} needs-work=${summary.byBand['needs-work']} weak=${summary.byBand.weak}`,
    );
    console.log(
      `  eval status:      validated=${summary.byEvalStatus.validated} implemented=${summary.byEvalStatus.implemented} planned=${summary.byEvalStatus.planned} missing=${summary.byEvalStatus.missing}`,
    );
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
        `  ${audit.craftbookId.padEnd(28)} ${String(audit.score).padStart(3)}/110 ${audit.band.padEnd(10)} eval=${audit.evalStatus}/${audit.validationScope}${lead ? `  ${lead.code}: ${lead.message}` : ''}`,
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
