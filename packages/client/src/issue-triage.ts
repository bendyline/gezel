import type {
  ApplyIssueVerdictsRequest,
  ApplyIssueVerdictsResponse,
  ImportIssueVerdictsRequest,
  ImportIssueVerdictsResponse,
  IssueHandoffDocumentResponse,
  IssueHandoffRequest,
  IssueHandoffResponse,
  IssueVerdictStatsResponse,
} from '@bendyline/gezel';
import type { ClientJsonRequest } from './office-integrations.js';

/**
 * Verdicts on Boekwachter issues, from the person, a gezel or an outside
 * coding app. Reached as `client.issueTriage`. The daemon decides who a
 * verdict is from by the credential, so no field here names the author. See
 * docs/issue-triage.md.
 */
export class IssueTriageClient {
  constructor(private readonly request: ClientJsonRequest) {}

  /**
   * The next batch of issues to check, grouped by file. Asked by an outside
   * app, it also holds them for that app for a while.
   */
  handoffQueue(projectId: string, body: IssueHandoffRequest = {}): Promise<IssueHandoffResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tools/issue-handoff`,
      body,
    );
  }

  /** The handoff document: the next batch as markdown with a response block under each issue. */
  handoffDocument(
    projectId: string,
    body: IssueHandoffRequest = {},
  ): Promise<IssueHandoffDocumentResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tools/issue-handoff/document`,
      body,
    );
  }

  /** Read a filled-in handoff document back. Gezel's own clients only. */
  importVerdicts(
    projectId: string,
    body: ImportIssueVerdictsRequest,
  ): Promise<ImportIssueVerdictsResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tools/issue-verdicts/import`,
      body,
    );
  }

  /** How often the reviewer's leads turned out real, by category, model and app. */
  stats(projectId: string): Promise<IssueVerdictStatsResponse> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectId)}/index/issue-stats`);
  }

  /** Apply verdicts; each comes back applied or refused, with the reason. */
  applyVerdicts(
    projectId: string,
    body: ApplyIssueVerdictsRequest,
  ): Promise<ApplyIssueVerdictsResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/tools/issue-verdicts`,
      body,
    );
  }
}
