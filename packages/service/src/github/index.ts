export {
  GitHubManager,
  MissingPatError,
  NoGithubLinkError,
  GitNotInstalledError,
} from './manager.js';
export type { CheckoutResolution, GithubStatus, GithubCredentialSource } from './manager.js';
export { AmbientGithubAuth } from './ambient.js';
export type { AmbientToken, AmbientSource } from './ambient.js';
export { GithubPrs } from './prs.js';
export { parseGithubUrl, sameGithubRepo, authenticatedCloneUrl } from './url.js';
export type { ParsedGithubUrl } from './url.js';
