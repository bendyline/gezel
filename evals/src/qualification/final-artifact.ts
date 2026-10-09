import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/** A bounded second grade catches changes made after the first artifact pass. */
export async function checkFinalArtifact(
  scenario: EvalScenario,
  context: EvalContext,
  timeoutMs = 5000,
): Promise<SuccessCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      scenario.successCheck(context),
      new Promise<SuccessCheckResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              done: true,
              success: false,
              reason: 'grader unavailable: final artifact check timed out',
            }),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    return { done: true, success: false, reason: 'grader unavailable: final artifact check threw' };
  } finally {
    clearTimeout(timer);
  }
}
