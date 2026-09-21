/** A host-provided, revocable snapshot. It carries no product/API authority. */
export interface HostHtmlPreview {
  url: string;
  dispose(): void;
}
export interface HostHtmlPreviewRequest {
  projectId: string;
  source: 'workspace' | 'artifacts' | 'type';
  path: string;
}
