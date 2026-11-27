import {
  type MolenCheckIssue,
  type MolenCheckResponse,
  type MolenDocumentKind,
  claimedMolenKind,
  createLogger,
} from '@bendyline/gezel';

const log = createLogger('molen');

/**
 * Optional until its first npm release: the service declares it only while
 * `pnpm link:molen` is active (an unpublished version in package.json breaks
 * every frozen-lockfile install), so an install without it still installs and
 * boots, and only the Molen document checks are missing. The specifier is a
 * variable so neither the typecheck nor the bundler needs the package present.
 */
const MOLEN_STAGE_PACKAGE = '@bendyline/molen-stage';

interface StageIssue {
  path: string;
  code: string;
  message: string;
  hint?: string;
}

/** The one export of `@bendyline/molen-stage` this file uses. */
export interface MolenStage {
  checkDocument(
    doc: unknown,
  ):
    | { ok: true; kind: MolenDocumentKind; notices: StageIssue[]; summary: string }
    | { ok: false; kind: MolenDocumentKind | null; issues: StageIssue[]; formatted: string };
}

/** Said wherever a check was asked for and cannot run: by the route, and by the gate. */
export const MOLEN_CHECK_UNAVAILABLE = `this install cannot check Molen documents: it does not include ${MOLEN_STAGE_PACKAGE}`;

let stage: Promise<MolenStage | null> | undefined;

/** The package, loaded once on first use, or null when this install lacks it. */
export function loadMolenStage(): Promise<MolenStage | null> {
  stage ??= (async () => {
    try {
      const specifier: string = MOLEN_STAGE_PACKAGE;
      const mod = (await import(/* @vite-ignore */ specifier)) as Partial<MolenStage>;
      if (typeof mod.checkDocument === 'function') return mod as MolenStage;
      log.warn(
        `[molen] ${MOLEN_STAGE_PACKAGE} has no checkDocument; Molen documents are not checked`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.info(
        `[molen] ${MOLEN_STAGE_PACKAGE} is not installed; Molen documents are not checked (${message})`,
      );
    }
    return null;
  })();
  return stage;
}

/** Replace the loaded package for a test; returns the restore. */
export function useMolenStageForTests(replacement: MolenStage | null): () => void {
  const previous = stage;
  stage = Promise.resolve(replacement);
  return () => {
    stage = previous;
  };
}

/**
 * The one check every surface asks about a Molen document a gezel wrote: the
 * MCP write tools (in the same turn as the write), `validate`, the
 * `molenDocument` gate check, and the check route. A film or game must
 * compile and a scene must validate with no scripts, which is what a player
 * needs to play it; nothing in the document is ever run as code.
 *
 * Null when this install cannot check (see {@link loadMolenStage}). Text is
 * parsed here, so a document cut off mid-write gets an answer that says so
 * instead of a silent skip.
 */
export async function checkMolenDocument(input: unknown): Promise<MolenCheckResponse | null> {
  const molen = await loadMolenStage();
  if (!molen) return null;
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const formatted = `The document is not valid JSON: ${message}. Write it again as one complete JSON object.`;
      return {
        ok: false,
        kind: claimedMolenKind(input),
        issues: [{ path: '', code: 'invalid_json', message: `not valid JSON: ${message}` }],
        notices: [],
        formatted,
      };
    }
  }
  const result = molen.checkDocument(doc);
  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      issues: result.issues.map(toIssue),
      notices: [],
      formatted: result.formatted,
    };
  }
  return {
    ok: true,
    kind: result.kind,
    summary: result.summary,
    issues: [],
    notices: result.notices.map(toIssue),
  };
}

function toIssue(issue: StageIssue): MolenCheckIssue {
  return {
    path: issue.path,
    code: issue.code,
    message: issue.message,
    ...(issue.hint ? { hint: issue.hint } : {}),
  };
}
