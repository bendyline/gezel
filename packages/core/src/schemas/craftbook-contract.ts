import { z } from 'zod';
import { DeliverableKindSchema } from './deliverable-kind.js';
import { type GateCheck, GateCheckSchema } from './gate.js';

/**
 * ─ Craftbook contract ─────────────────────────────────────────────────
 *
 * What a book promises, independent of how it is carried out: the final
 * goal, the deliverables, and the bar they must clear. Every task-completion
 * strategy (stepwise, generalist, outcome) is held to the same contract, so
 * a comparison between strategies measures the strategy and not the recipe.
 *
 * Before this block a book's bar lived in step gates, usually on a middle
 * step, and the acceptance criteria were written by the model at run time
 * in a scope step. A strategy that skips the recipe could not be graded on
 * the same terms. Process belongs in steps; only what the person asked for
 * belongs here ("reproduce with a failing test first" is a contract item
 * only when the request demands it).
 *
 * Named `contract` so it is not confused with `Task.outcomes`, the planner's
 * self-attested checklist.
 */

const ContractIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const ContractDeliverableSchema = z.object({
  id: ContractIdSchema,
  /** May carry `{{param}}` and `{{task.*}}` tokens; interpolated with the steps. */
  path: z.string().min(1),
  /** In the project artifacts drawer rather than the workspace. */
  artifact: z.boolean().optional(),
  kind: DeliverableKindSchema,
  /** Absent means `primary`: the thing the person asked for. */
  role: z.enum(['primary', 'supporting']).optional(),
  /** One line a person would recognize. */
  description: z.string().min(1),
  /**
   * The gradable text behind a binary deliverable (the Markdown a deck was
   * converted from). Judges and claim checks read this, not the container.
   */
  textSource: z
    .object({ path: z.string().min(1), artifact: z.boolean().optional() })
    .strict()
    .optional(),
});
export type ContractDeliverable = z.infer<typeof ContractDeliverableSchema>;

export const ContractCriterionSchema = z
  .object({
    id: ContractIdSchema,
    /** `acceptance`: the deliverable exists and has the asked-for shape. `quality`: it is good. */
    kind: z.enum(['acceptance', 'quality']),
    /** Shown identically to every strategy. */
    text: z.string().min(1),
    /**
     * `gate` (default): the runtime holds the task until the checks pass.
     * `advisory`: shown, not enforced. `eval-only`: graded by the eval, not
     * enforced at run time.
     */
    enforce: z.enum(['gate', 'advisory', 'eval-only']).optional(),
    checks: z.array(GateCheckSchema).optional(),
    /** A rubric for what no mechanical check can see. Never gates. */
    judge: z
      .object({ rubric: z.string().min(1) })
      .strict()
      .optional(),
  })
  .superRefine((criterion, ctx) => {
    if (criterionEnforce(criterion) === 'gate' && (criterion.checks?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: `criterion "${criterion.id}" is enforced as a gate but has no checks; add checks or set enforce to "advisory"`,
      });
    }
  });
export type ContractCriterion = z.infer<typeof ContractCriterionSchema>;

export const ContractInputSchema = z
  .object({
    path: z.string().min(1),
    artifact: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .strict();
export type ContractInput = z.infer<typeof ContractInputSchema>;

export const ContractGroundingSchema = z
  .object({
    /**
     * The material facts must come from: supplied files, a corpus folder,
     * `knowledge://` refs. Absent when the work finds its own sources (web
     * research): claims are then checked against whatever the deliverable cites.
     */
    sources: z.array(z.string().min(1)).min(1).optional(),
    citationStyle: z.enum(['numbered', 'inline-path', 'any']).optional(),
  })
  .strict();
export type ContractGrounding = z.infer<typeof ContractGroundingSchema>;

export const CraftbookContractSchema = z
  .object({
    /** The final goal and the bar it must clear, in one or two sentences. */
    goal: z.string().min(1).max(400),
    inputs: z.array(ContractInputSchema).optional(),
    deliverables: z.array(ContractDeliverableSchema).min(1),
    criteria: z.array(ContractCriterionSchema).min(1),
    grounding: ContractGroundingSchema.optional(),
  })
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    for (const [i, d] of contract.deliverables.entries()) {
      if (seen.has(d.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deliverables', i, 'id'],
          message: `duplicate deliverable id "${d.id}"`,
        });
      }
      seen.add(d.id);
    }
    const criteria = new Set<string>();
    for (const [i, c] of contract.criteria.entries()) {
      if (criteria.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria', i, 'id'],
          message: `duplicate criterion id "${c.id}"`,
        });
      }
      criteria.add(c.id);
    }
    if (!contract.deliverables.some((d) => deliverableRole(d) === 'primary')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliverables'],
        message: 'a contract needs at least one primary deliverable',
      });
    }
  });
export type CraftbookContract = z.infer<typeof CraftbookContractSchema>;

export function criterionEnforce(
  criterion: Pick<ContractCriterion, 'enforce'>,
): 'gate' | 'advisory' | 'eval-only' {
  return criterion.enforce ?? 'gate';
}

export function deliverableRole(
  deliverable: Pick<ContractDeliverable, 'role'>,
): 'primary' | 'supporting' {
  return deliverable.role ?? 'primary';
}

/** The checks the runtime enforces, in criterion order. */
export function contractGateChecks(contract: CraftbookContract): GateCheck[] {
  return contract.criteria
    .filter((c) => criterionEnforce(c) === 'gate')
    .flatMap((c) => c.checks ?? []);
}

/** True when the contract holds claims to sources, so whoever writes must cite them. */
export function contractAsksForGrounding(contract: CraftbookContract | undefined): boolean {
  if (!contract) return false;
  if (contract.grounding) return true;
  return contract.criteria.some((c) => c.checks?.some((check) => check.kind === 'claimsGrounded'));
}
