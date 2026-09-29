/**
 * Reason fragments for a trial the harness could not grade on this machine.
 *
 * Neither says anything about the model: the deliverable may be perfect, and
 * the tool that would have checked it (Chromium, Vitest) is missing. The
 * failure classifier files both as `grader`, which the scorecard drops from
 * numerator and denominator alike.
 */
export const RUNTIME_LAYER_UNAVAILABLE = 'runtime layer unavailable';
export const GRADER_TOOL_UNAVAILABLE = 'grader tool unavailable';

export const GRADER_UNAVAILABLE_PATTERN = /runtime layer unavailable|grader tool unavailable/;
