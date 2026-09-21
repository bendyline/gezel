export function isExpectedBinaryDocumentDeliverablePath(path: string): boolean {
  return /\.(?:pptx|docx|xlsx|pdf|epub|dbk|mp4|gif)$/i.test(path.trim());
}

export function isExpectedImageDeliverablePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(path.trim());
}
