export {
  createDocumentMediaProvider,
  createDocumentsContentContainer,
  deriveContainerScope,
} from './documents-container.js';
export type { DocumentsContentContainerOptions } from './documents-container.js';

export {
  documentVersionBasename,
  isMarkdownDocumentPath,
  markdownCompanionDirectory,
  moveFileWithCompanion,
} from './document-companion.js';

export { createVersionCompatibleContentContainer } from './version-compatible-container.js';

export {
  createArtifactsContentContainer,
  createProjectContentContainer,
} from './artifacts-container.js';
export type { ArtifactsContentContainerOptions } from './artifacts-container.js';

export {
  chooseOutsideInSource,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  relativePath,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  runtimePathForTarget,
  withOutsideInMetadata,
  withOutsideInMarkdownEditing,
} from './outside-in.js';
export type { OutsideInFormat, OutsideInLayout } from './outside-in.js';
export { isOutsideInInternalPath } from '@bendyline/gezel';

export {
  canDropDocumentFile,
  DROPPABLE_DOCUMENT_EXTENSIONS,
  importDroppedFiles,
} from './document-import.js';
export type { DroppedDocumentImportResult, DroppedFileTarget } from './document-import.js';

export { createDocumentLinkProvider } from './document-link-provider.js';
export type { DocumentLinkProviderOptions } from './document-link-provider.js';

export {
  DEFAULT_PROOFING_PREFERENCES,
  gezelProofingIgnoreStore,
  gezelProofingProvider,
  getProofingPreferences,
  setProofingPreferences,
} from './proofing.js';
export type { ProofingPreferences } from './proofing.js';
export { useProofingCapability } from './useProofingCapability.js';
