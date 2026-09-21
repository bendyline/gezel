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
  structuredQuestions: boolean;
  terminal: boolean;
  git: boolean;
  index: boolean;
  search: boolean;
  memories: boolean;
  background: boolean;
  catalog: boolean;
  htmlPreview: boolean;
  daemonSettings: boolean;
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
  structuredQuestions: true,
  terminal: true,
  git: true,
  index: true,
  search: true,
  memories: true,
  background: true,
  catalog: true,
  htmlPreview: true,
  daemonSettings: true,
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
  structuredQuestions: true,
  terminal: false,
  git: false,
  index: false,
  search: true,
  memories: true,
  background: false,
  catalog: false,
  htmlPreview: false,
  daemonSettings: false,
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
  mediaExport: false,
  chatAttachments: false,
  queuedChat: false,
  textTransforms: true,
});
