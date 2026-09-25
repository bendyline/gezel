export {
  firstActionForKind,
  RESEARCH_STEP_TOOLS,
  type StepKit,
  stepToolKit,
  unionStepKit,
  gateRepairToolsForKind,
  capPriorityPrefixForKind,
  stepGateRepairActive,
} from '@bendyline/gezel';

/** Kill switch for kit narrowing (D4 feature half). */
export function stepToolKitDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEZEL_DISABLE_STEP_TOOL_KIT === '1';
}

/** Kill switch for the repair-clamp lifetime fix (D4 bugfix half). */
export function repairClampDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GEZEL_DISABLE_REPAIR_CLAMP === '1';
}
