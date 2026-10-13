export interface ApiObservationContext {
  sessionId?: string;
  gezelId?: string;
  projectId?: string;
  taskRef?: string;
  executionMode?: string;
  behaviors?: Array<{ id: string; config?: unknown }>;
  promptSections?: Array<{ name: string; tokens: number; band: string }>;
}
