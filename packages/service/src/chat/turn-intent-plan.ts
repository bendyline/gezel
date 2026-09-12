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

/**
 * Deterministic, high-precision artifact routing. This is intentionally much
 * narrower than catalog search: a preview must not flash merely because a
 * file type was mentioned while the user is asking a question about it.
 */
export function detectExactArtifactRoute(text: string): ExactArtifactRoute | null {
  const normalized = text.trim();
  if (!normalized) return null;
  if (INFORMATIONAL_OPEN_RE.test(normalized) && !USER_REQUEST_RE.test(normalized)) return null;
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
  const roleId = resolveRoleId(input.role);
  const isCoordinator = input.isMeester || roleId === 'meester' || roleId === 'voorman';
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
          ...(artifact.format === 'pptx' ? { params: { topic: text } } : {}),
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

/** Tiny coordinators get one pre-resolved action instead of a two-tool menu. */
export function shouldConstrainToExactCraftbookInvocation(args: {
  role: string | undefined;
  tier: ModelTier | undefined;
  latestUserMessage: string | undefined;
}): boolean {
  return (
    args.tier === 'tiny' &&
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
