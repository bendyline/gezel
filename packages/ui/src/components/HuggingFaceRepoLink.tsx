export type HuggingFaceRepoType = 'model' | 'dataset';

/** Hub page for an `owner/repo` id: a model card, or a dataset card for `repoType: 'dataset'`. */
export function huggingFaceRepoUrl(repo: string, repoType: HuggingFaceRepoType = 'model'): string {
  const path = repo.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repoType === 'dataset' ? 'datasets/' : ''}${path}`;
}

/**
 * The `owner/repo` chip on a catalog card, linked to that repository on
 * Hugging Face. That page is the primary record for the bytes gezel actually
 * downloads — file list, quantization or release notes, and the license the
 * uploader published under — so the id doubles as the "where does this come
 * from?" answer rather than being an opaque string.
 */
export function HuggingFaceRepoLink({
  repo,
  repoType = 'model',
}: {
  repo: string;
  repoType?: HuggingFaceRepoType;
}) {
  return (
    <a
      className="hf-repo-link"
      href={huggingFaceRepoUrl(repo, repoType)}
      target="_blank"
      rel="noreferrer"
      title={`View ${repo} on Hugging Face`}
    >
      <code>{repo}</code>
    </a>
  );
}
