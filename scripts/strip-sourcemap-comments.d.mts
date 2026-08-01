export interface StripSourcemapCommentsTextResult {
  text: string;
  commentsRemoved: number;
}

export interface StripSourcemapCommentsResult {
  filesChanged: number;
  commentsRemoved: number;
}

export function stripSourcemapCommentsFromText(source: string): StripSourcemapCommentsTextResult;

export function stripSourcemapComments(
  roots: readonly string[],
): Promise<StripSourcemapCommentsResult>;

export function stripSourcemapCommentsFromBuild(
  root?: string,
): Promise<StripSourcemapCommentsResult>;
