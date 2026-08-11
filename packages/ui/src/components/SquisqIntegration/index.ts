export {
  createDocumentsContentContainer,
  deriveContainerScope,
} from './documents-container.js';
export type { DocumentsContentContainerOptions } from './documents-container.js';

export {
  createArtifactsContentContainer,
  createProjectContentContainer,
} from './artifacts-container.js';
export type { ArtifactsContentContainerOptions } from './artifacts-container.js';

export {
  chooseOutsideInSource,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  isOutsideInInternalPath,
  relativePath,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  runtimePathForTarget,
  withOutsideInMetadata,
  withOutsideInMarkdownEditing,
} from './outside-in.js';
export type { OutsideInFormat, OutsideInLayout } from './outside-in.js';

export { createDocumentLinkProvider } from './document-link-provider.js';
export type { DocumentLinkProviderOptions } from './document-link-provider.js';
