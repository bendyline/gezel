import {
  type ChatMessageToolCall,
  type ModelTier,
  type TurnIntentPlan,
  resolveRoleId,
} from '@bendyline/gezel';

interface ExactArtifactRoute {
  format: 'pptx' | 'docx' | 'pdf' | 'mp4' | 'gif';
  outputLabel: string;
  craftbookId: string;
  craftbookName: string;
}

const PRODUCTION_ACTION_RE =
  /\b(?:build|convert|create|design|draft|edit|export|generate|make|prepare|produce|render|revise|turn|update|write)\b/i;
const USER_REQUEST_RE =
  /\b(?:can\s+you|could\s+you|please|i\s+(?:need|want|would\s+like)|we\s+(?:need|want|would\s+like))\b/i;
const INFORMATIONAL_OPEN_RE =
  /^\s*(?:(?:how|what|why|when|where|who)\b|(?:are|can|could|did|do|does|is|will|would)(?!\s+you\b)\b)/i;
// Acting on, or asking after, a deliverable that already exists — "cancel the
// PowerPoint task", "how the deck is going", "update my presentation". An
// exact route leaves `invoke_craftbook` as the only tool, so each of these
// used to start a second, unrelated run instead of reaching the first.
const EXISTING_WORK_RE =
  /\b(?:cancel|stop|pause|resume|retry|restart|abort|delete|remove|update|edit|revise|fix|change|tweak|shorten|extend|finish|check\s+on|status\s+of|progress\s+on|how(?:'s|\s+is|\s+are)?|where(?:'s|\s+is|\s+are)?)\s+(?:the|that|this|my|our|your)\s+(?:[\w-]+\s+){0,2}?(?:power\s*point|pptx?|deck|presentation|slides?|slide\s*show|docx?|document|report|pdf|task)\b/i;

/**
 * Is this text asking for work at all — rather than asking a question, or
 * asking after work already under way? Shared by the exact-format routes
 * and the catalog trigger tier so neither proposes a launch for "how do I
 * write meeting minutes?" or "cancel the deck".
 */
export function looksLikeWorkRequest(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (INFORMATIONAL_OPEN_RE.test(normalized) && !USER_REQUEST_RE.test(normalized)) return false;
  if (EXISTING_WORK_RE.test(normalized)) return false;
  return true;
}

/** Meester or voorman: the roles a person asks for work through. */
export function isCoordinatorRole(input: { isMeester: boolean; role?: string }): boolean {
  const roleId = resolveRoleId(input.role);
  return input.isMeester || roleId === 'meester' || roleId === 'voorman';
}

/**
 * Deterministic, high-precision artifact routing. This is intentionally much
 * narrower than catalog search: a preview must not flash merely because a
 * file type was mentioned while the user is asking a question about it.
 */
export function detectExactArtifactRoute(text: string): ExactArtifactRoute | null {
  const normalized = text.trim();
  if (!looksLikeWorkRequest(normalized)) return null;
  if (!PRODUCTION_ACTION_RE.test(normalized) && !USER_REQUEST_RE.test(normalized)) return null;

  if (/\b(?:power\s*point|pptx?|slide\s+deck|presentation\s+deck)\b/i.test(normalized)) {
    return {
      format: 'pptx',
      outputLabel: 'PowerPoint (.pptx)',
      craftbookId: 'powerpoint-deck',
      craftbookName: 'PowerPoint from Content',
    };
  }
  if (/\b(?:docx|microsoft\s+word|word\s+document)\b/i.test(normalized)) {
    return {
      format: 'docx',
      outputLabel: 'Word document (.docx)',
      craftbookId: 'research-to-document',
      craftbookName: 'Word Document from Content or Research',
    };
  }
  if (/\b(?:pdf\s+report|report\s+(?:as|to|in)\s+(?:a\s+)?pdf|pdf)\b|\.pdf\b/i.test(normalized)) {
    return {
      format: 'pdf',
      outputLabel: 'PDF report (.pdf)',
      craftbookId: 'report-pdf',
      craftbookName: 'Formatted Report',
    };
  }
  const slideshow = /\b(?:animated\s+(?:slide\s*show|presentation)|slide\s*show)\b/i.test(
    normalized,
  );
  if (slideshow && /\b(?:mp4|video)\b/i.test(normalized)) {
    return {
      format: 'mp4',
      outputLabel: 'Animated slideshow (.mp4)',
      craftbookId: 'narrated-slideshow',
      craftbookName: 'Animated Content Slideshow',
    };
  }
  if (slideshow && /\b(?:gif|animated\s+gif)\b/i.test(normalized)) {
    return {
      format: 'gif',
      outputLabel: 'Animated slideshow (.gif)',
      craftbookId: 'narrated-slideshow',
      craftbookName: 'Animated Content Slideshow',
    };
  }
  return null;
}

const IMPLEMENTATION_ACTION_RE =
  /\b(?:build|code|debug|develop|fix|implement|migrate|refactor|repair|ship|test|upgrade)\b/i;
const IMPLEMENTATION_NOUN_RE =
  /\b(?:api|app|application|backend|bug|cli|code|codebase|component|database|endpoint|frontend|function|integration|library|package|repository|repo|schema|sdk|server|service|test|typescript|javascript|python|website)\b/i;

export function looksLikeImplementationRequest(text: string): boolean {
  return IMPLEMENTATION_ACTION_RE.test(text) && IMPLEMENTATION_NOUN_RE.test(text);
}

const DECK_SUBJECT_RE =
  /\b(?:about|on|covering|regarding|explaining|introducing)\s+(.+?)\s*(?:,?\s*please)?\s*[.?!]*\s*$/i;

/**
 * The subject of a deck request — "pizza" from "Create a PowerPoint about
 * pizza". The whole sentence used to become `topic`, which the research
 * step then searched for verbatim and the copywriter could title slides
 * with. Falls back to the full text when no subject clause is present;
 * the invocation's `description` always keeps the user's own words.
 */
export function deckTopicFromRequest(text: string): string {
  const subject = DECK_SUBJECT_RE.exec(text)?.[1]?.trim();
  return subject && subject.length > 0 ? subject : text;
}

export interface ResolveTurnIntentPlanInput {
  text: string;
  isMeester: boolean;
  role?: string;
}

/**
 * Build the plan synchronously so typing previews stay cheap and deterministic.
 * Future semantic/local-model review can enrich this result asynchronously,
 * but exact routes remain the fast first pass and source of truth.
 */
export function resolveTurnIntentPlan(input: ResolveTurnIntentPlanInput): TurnIntentPlan {
  const text = input.text.trim();
  const isCoordinator = isCoordinatorRole(input);
  const artifact = detectExactArtifactRoute(text);
  if (artifact && isCoordinator) {
    return {
      schemaVersion: 1,
      intent: 'artifact',
      route: 'craftbook',
      confidence: 'high',
      reason: 'exact-output-format',
      visible: true,
      display: {
        label: `Planned: ${artifact.outputLabel}`,
        detail: artifact.craftbookName,
        badges: [artifact.format.toUpperCase(), 'Craftbook'],
      },
      output: { format: artifact.format, label: artifact.outputLabel },
      craftbook: {
        id: artifact.craftbookId,
        name: artifact.craftbookName,
        invocation: {
          description: text,
          ...(artifact.format === 'pptx' ? { params: { topic: deckTopicFromRequest(text) } } : {}),
        },
      },
      requiredTools: ['invoke_craftbook'],
    };
  }

  if (isCoordinator && looksLikeImplementationRequest(text)) {
    return {
      schemaVersion: 1,
      intent: 'implementation',
      route: 'specialist',
      confidence: 'medium',
      reason: 'implementation-request',
      visible: true,
      display: {
        label: 'Planned: Developer',
        detail: 'Route implementation work to a developer gezel',
        badges: ['Developer'],
      },
      specialist: { role: 'developer', label: 'Developer' },
      requiredTools: ['message_gezel'],
    };
  }

  return {
    schemaVersion: 1,
    intent: 'conversation',
    route: 'none',
    confidence: 'low',
    reason: 'no-strong-signal',
    visible: false,
    display: { label: 'Conversation', badges: [] },
    requiredTools: [],
  };
}

/**
 * A coordinator on a high-confidence exact-artifact route gets ONE
 * pre-resolved action instead of a menu, at every model tier.
 *
 * The gate used to be `tier === 'tiny'`, on the theory that only the smallest
 * coordinators lose the route. A medium 27B disproved it: handed the exact
 * `invoke_craftbook(...)` call in its prelude AND the same call again in the
 * `suggest_craftbook` result, it browsed the 49-tool menu instead, called
 * `ensure_gezel` eight times, reasoned itself into believing
 * `invoke_craftbook` was not wired, and died on the repeat-loop abort with no
 * task and no .pptx. Parameter count was never the right predictor — route
 * confidence is. When `detectExactArtifactRoute` resolves the whole call
 * there is nothing left for any model to choose, and a menu is only an
 * opportunity to choose wrong.
 *
 * Subtractive only: the caller ANDs this with the role/security allowlist, so
 * it can never grant `invoke_craftbook` to a session that was denied it.
 */
export function shouldConstrainToExactCraftbookInvocation(args: {
  role: string | undefined;
  latestUserMessage: string | undefined;
}): boolean {
  return (
    ['meester', 'voorman'].includes(resolveRoleId(args.role) ?? '') &&
    Boolean(detectExactArtifactRoute(args.latestUserMessage ?? ''))
  );
}

/** Render the compact per-turn instruction from the same plan shown in the composer. */
export function renderTurnIntentPrelude(plan: TurnIntentPlan): string | null {
  if (plan.route === 'craftbook' && plan.craftbook && plan.output) {
    const args = JSON.stringify({
      craftbookId: plan.craftbook.id,
      description: plan.craftbook.invocation.description,
      ...(plan.craftbook.invocation.params ? { params: plan.craftbook.invocation.params } : {}),
    });
    return `(System route for this turn: the user asked for a real ${plan.output.label}. Use the existing “${plan.craftbook.name}” procedure now. Your required action is \`invoke_craftbook(${args})\`. Do not start a new project, delegate this as developer work, substitute Markdown/HTML, or claim the output is unavailable because you cannot see a direct file-conversion tool. The invoked procedure supplies its workers with the production capabilities they need.)`;
  }
  if (plan.route === 'specialist' && plan.specialist) {
    return `(System route for this turn: this is implementation work. Route it to a ${plan.specialist.label} gezel with your team tools instead of attempting the code changes yourself.)`;
  }
  return null;
}

const CAPABILITY_DENIAL_RE =
  /\b(?:can(?:not|['’]t)|unable\s+to|do\s+not\s+have|don['’]t\s+have|lack(?:ing|s)?|no\s+(?:direct\s+)?(?:tool|ability|capability)|not\s+(?:able|equipped)|isn['’]t\s+available|is\s+not\s+available)\b/i;

/**
 * Catch the E2B failure mode: the coordinator inspects only its direct tools
 * and incorrectly denies a capability that lives inside the routed procedure.
 */
export function falseCapabilityDenialCorrection(args: {
  plan: TurnIntentPlan;
  assistantContent: string;
  toolCalls: readonly ChatMessageToolCall[];
}): string | null {
  if (args.plan.route !== 'craftbook' || !args.plan.craftbook || !args.plan.output) return null;
  if (!CAPABILITY_DENIAL_RE.test(args.assistantContent)) return null;
  if (
    args.toolCalls.some(
      (call) => call.name === 'invoke_craftbook' || call.name.endsWith('__invoke_craftbook'),
    )
  )
    return null;

  const invocation = args.plan.craftbook.invocation;
  const toolArgs = JSON.stringify({
    craftbookId: args.plan.craftbook.id,
    description: invocation.description,
    ...(invocation.params ? { params: invocation.params } : {}),
  });
  return `Correction: that capability is available through the preselected “${args.plan.craftbook.name}” procedure. Do not explain the tool boundary or ask to set up a project. Call \`invoke_craftbook(${toolArgs})\` now, then briefly tell the user the ${args.plan.output.label} work has started.`;
}
