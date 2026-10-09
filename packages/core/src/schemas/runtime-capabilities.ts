/** Product operations offered by a host, independent of screen size or OS.
 * A narrow desktop window retains desktop capabilities; a portable host only
 * advertises operations its local runtime can actually perform.
 */
export interface RuntimeCapabilities {
  projects: boolean;
  gezels: boolean;
  documents: boolean;
  artifacts: boolean;
  chat: boolean;
  promptDrafts: boolean;
  modelSettings: boolean;
  tasks: boolean;
  taskStructureEditing: boolean;
  taskNoteEditing: boolean;
  taskGateOverride: boolean;
  /**
   * The host reports what a task made (`/tasks/:num/outputs`: its
   * deliverable and every file). False where it cannot; omitted means it can.
   */
  taskOutputs?: boolean;
  structuredQuestions: boolean;
  terminal: boolean;
  git: boolean;
  index: boolean;
  search: boolean;
  memories: boolean;
  background: boolean;
  /** Gezels earn XP and level up, with a Growth tab to choose what they learn. */
  growth: boolean;
  catalog: boolean;
  /**
   * The host lists and creates catalog project types (`/api/catalog/project-type`,
   * `POST /api/projects/typed`) even without the full catalog. Omitted means
   * it follows `catalog`.
   */
  projectTypes?: boolean;
  htmlPreview: boolean;
  daemonSettings: boolean;
  /**
   * The host reports its engine and queue live (`/api/queues`, running
   * turns, `engine_phase`), so the header's engine and queue keys can show.
   * Managing the engine stays with `daemonSettings`.
   */
  engineStatus: boolean;
  /**
   * The host logs renderer timings beside its own (`POST /api/system/perf/client`).
   * False where it keeps no such log; omitted means it does.
   */
  perfReports?: boolean;
  externalFolders: boolean;
  scripts: boolean;
  scriptAuthoring: boolean;
  scriptAiDrafting: boolean;
  /** Starter scripts the host can execute; omitted hosts offer the full desktop SDK. */
  scriptTemplates?: readonly (
    | 'blank'
    | 'post-message'
    | 'fetch-and-summarize'
    | 'check-files'
    | 'call-tool'
    | 'ask-ai'
  )[];
  knowledge: boolean;
  connections: boolean;
  backups: boolean;
  imageGeneration: boolean;
  multiRecipientChat: boolean;
  audio: boolean;
  /** False when speech models are supplied with the app rather than managed separately. */
  audioModelManagement?: boolean;
  mediaExport: boolean;
  chatAttachments: boolean;
  queuedChat: boolean;
  textTransforms: boolean;
}

export const DESKTOP_RUNTIME_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
  projects: true,
  gezels: true,
  documents: true,
  artifacts: true,
  chat: true,
  promptDrafts: true,
  modelSettings: true,
  tasks: true,
  taskStructureEditing: true,
  taskNoteEditing: true,
  taskGateOverride: true,
  taskOutputs: true,
  structuredQuestions: true,
  terminal: true,
  git: true,
  index: true,
  search: true,
  memories: true,
  background: true,
  growth: true,
  catalog: true,
  projectTypes: true,
  htmlPreview: true,
  daemonSettings: true,
  engineStatus: true,
  perfReports: true,
  externalFolders: true,
  scripts: true,
  scriptAuthoring: true,
  scriptAiDrafting: true,
  knowledge: true,
  connections: true,
  backups: true,
  imageGeneration: true,
  multiRecipientChat: true,
  audio: true,
  audioModelManagement: true,
  mediaExport: true,
  chatAttachments: true,
  queuedChat: true,
  textTransforms: true,
});

export const OFFLINE_RUNTIME_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
  projects: true,
  gezels: true,
  documents: true,
  artifacts: true,
  chat: true,
  promptDrafts: true,
  modelSettings: true,
  tasks: true,
  taskStructureEditing: true,
  taskNoteEditing: true,
  taskGateOverride: false,
  taskOutputs: false,
  structuredQuestions: true,
  terminal: false,
  git: false,
  index: false,
  search: true,
  memories: true,
  background: false,
  growth: false,
  catalog: false,
  projectTypes: false,
  htmlPreview: false,
  daemonSettings: false,
  engineStatus: true,
  perfReports: false,
  externalFolders: false,
  scripts: true,
  scriptAuthoring: true,
  scriptAiDrafting: false,
  scriptTemplates: ['blank', 'check-files', 'post-message'] as const,
  knowledge: false,
  connections: false,
  backups: true,
  imageGeneration: false,
  multiRecipientChat: false,
  audio: false,
  audioModelManagement: false,
  mediaExport: false,
  // Photos and files land in the prompt draft's message_files/ like the
  // desktop's. The send path inlines text files and tells the model when it
  // cannot see an image (no on-device provider takes images yet).
  chatAttachments: true,
  queuedChat: true,
  textTransforms: true,
});
