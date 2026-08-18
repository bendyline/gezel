/** Model card page for a `owner/repo` id, e.g. `unsloth/gemma-4-12B-it-qat-GGUF`. */
export function huggingFaceRepoUrl(repo: string): string {
  return `https://huggingface.co/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The `owner/repo` chip on a model card, linked to that repository on Hugging
 * Face. That page is the primary record for the weights gezel actually
 * downloads — file list, quantization notes, and the license the uploader
 * published under — so the id doubles as the "where does this come from?"
 * answer rather than being an opaque string.
 */
export function HuggingFaceRepoLink({ repo }: { repo: string }) {
  return (
    <a
      className="hf-repo-link"
      href={huggingFaceRepoUrl(repo)}
      target="_blank"
      rel="noreferrer"
      title={`View ${repo} on Hugging Face`}
    >
      <code>{repo}</code>
    </a>
  );
}
