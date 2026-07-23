export type Band = 'ship-ready' | 'capability-bound' | 'systemic-issue' | string;

export type ArtifactKind = 'html' | 'image' | 'plan';

export interface Artifact {
  kind: ArtifactKind;
  relPath: string;
  url: string;
  bytes: number;
  mtimeMs: number;
}

export interface Trial {
  trialId: string;
  scenarioId: string | null;
  modelId: string | null;
  runDir: string;
  runUrl: string;
  group: string;
  groupKind: 'matrix' | 'batch' | 'standalone';
  startedAt: string | null;
  finishedAt: string | null;
  dayKey: string | null;
  durationMs: number | null;
  /** True while the trial is in flight (status.json present, no result.json yet). */
  running: boolean;
  success: boolean;
  reason: string | null;
  failureMode: string | null;
  composite: number | null;
  band: Band | null;
  hasPostmortem: boolean;
  host: {
    cpuModel: string | null;
    totalRamGb: number | null;
    gpuModel: string | null;
    framework: string | null;
    hostname: string | null;
  } | null;
  perf: {
    peakRssMb: number | null;
    peakCpuPercent: number | null;
  } | null;
  artifacts: Artifact[];
}

export interface RunsIndex {
  generatedAt: string;
  runsRoot: string;
  counts: { trials: number; running: number; scored: number; passed: number };
  scenarios: string[];
  models: string[];
  days: string[];
  trials: Trial[];
}
