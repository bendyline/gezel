export interface RepoIntakeRedirect {
  url?: string;
  projectName: string;
  message: string;
}

export interface RepoIntakeRedirectInput {
  tool: string;
  text: string;
  projectName?: string;
  mode?: 'macro' | 'handoff';
}

const GITHUB_REPO_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]*[A-Za-z0-9_-])(?:\.git)?(?:\/[^\s)"'`<>]*)?/i;

export function extractGitHubRepoUrl(text: string): string | undefined {
  const match = text.match(GITHUB_REPO_URL_RE);
  if (!match) return undefined;
  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, '');
  if (!owner || !repo) return undefined;
  return `https://github.com/${owner}/${repo}`;
}

function knownRepoShortcut(text: string): { url: string; projectName: string } | null {
  if (/\bsquisq\b/i.test(text)) {
    return { url: 'https://github.com/bendyline/squisq', projectName: 'Squisq Code Review' };
  }
  return null;
}

function titleCaseRepoName(repo: string): string {
  return repo
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

function projectNameFromUrl(url: string): string {
  const repo = url.split('/').pop() || 'Repository';
  return `${titleCaseRepoName(repo)} Code Review`;
}

function looksLikeRepoSourceWork(text: string, hasUrl: boolean): boolean {
  if (
    /\b(review|audit|analy[sz]e|analysis|inspect|architecture|codebase|source code|walk the source|read (?:the )?source|fix|debug|change|work with)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return hasUrl && /\b(repo|repository|clone|fetch_repo)\b/i.test(text);
}

export function repoIntakeRedirect(input: RepoIntakeRedirectInput): RepoIntakeRedirect | null {
  const url = extractGitHubRepoUrl(input.text);
  const shortcut = url ? null : knownRepoShortcut(input.text);
  const targetUrl = url ?? shortcut?.url;
  if (!targetUrl || !looksLikeRepoSourceWork(input.text, Boolean(url))) return null;

  const projectName =
    input.projectName?.trim() || shortcut?.projectName || projectNameFromUrl(targetUrl);
  const fetchCall = `fetch_repo({ url: "${targetUrl}", projectName: "${projectName}" })`;
  const prefix =
    input.mode === 'macro'
      ? `${input.tool} is the wrong macro for remote repository review/analysis because it creates an empty bootstrap project with no source code.`
      : `${input.tool} cannot hand off remote repository work from this project until the source repository has been fetched.`;
  return {
    url: targetUrl,
    projectName,
    message: `${prefix} Call \`${fetchCall}\` first; that creates the project and clones the repository into the workspace root. After it returns, pass the returned projectId to any reviewer or specialist. Do not ask the user to paste source code.`,
  };
}
