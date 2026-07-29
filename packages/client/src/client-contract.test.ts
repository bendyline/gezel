import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from './client.js';

interface ContractCase {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  invoke(client: GezelClient): Promise<unknown>;
}

const cases: ContractCase[] = [
  { name: 'health', method: 'GET', path: '/api/health', invoke: (c) => c.health() },
  {
    name: 'code review start',
    method: 'POST',
    path: '/api/projects/p1/git/reviews',
    body: { kind: 'pr' },
    invoke: (c) => c.startProjectCodeReview('p1', { kind: 'pr' }),
  },
  {
    name: 'code review list',
    method: 'GET',
    path: '/api/projects/p1/git/reviews',
    invoke: (c) => c.listProjectCodeReviews('p1'),
  },
  {
    name: 'code review read with escaping',
    method: 'GET',
    path: '/api/projects/p1/git/reviews/pr-20260729%2Fx',
    invoke: (c) => c.getProjectCodeReview('p1', 'pr-20260729/x'),
  },
  {
    name: 'code review cancel',
    method: 'POST',
    path: '/api/projects/p1/git/reviews/pr-20260729-093000-ab12/cancel',
    invoke: (c) => c.cancelProjectCodeReview('p1', 'pr-20260729-093000-ab12'),
  },
  {
    name: 'git status uses the canonical git segment',
    method: 'GET',
    path: '/api/projects/p1/git/status',
    invoke: (c) => c.getProjectGitStatus('p1'),
  },
  {
    name: 'deprecated github status alias still resolves',
    method: 'GET',
    path: '/api/projects/p1/git/status',
    invoke: (c) => c.getProjectGithubStatus('p1'),
  },
  { name: 'usage', method: 'GET', path: '/api/usage', invoke: (c) => c.getUsage() },
  { name: 'queue status', method: 'GET', path: '/api/queues', invoke: (c) => c.getQueueStatus() },
  {
    name: 'cancel queue item',
    method: 'DELETE',
    path: '/api/queues/open%2Fai/7',
    invoke: (c) => c.cancelProviderQueueItem('open/ai', 7),
  },
  {
    name: 'move queue item',
    method: 'POST',
    path: '/api/queues/openai/7/move',
    body: { direction: 'up' },
    invoke: (c) => c.moveProviderQueueItem('openai', 7, 'up'),
  },
  { name: 'config read', method: 'GET', path: '/api/config', invoke: (c) => c.getConfig() },
  {
    name: 'config update',
    method: 'PUT',
    path: '/api/config',
    body: { provider: 'openai' },
    invoke: (c) => c.updateConfig({ provider: 'openai' }),
  },
  { name: 'channel list', method: 'GET', path: '/api/channels', invoke: (c) => c.listChannels() },
  {
    name: 'channel send',
    method: 'POST',
    path: '/api/channels/send',
    body: { message: 'hello' },
    invoke: (c) => c.sendChannelMessage({ message: 'hello' }),
  },
  { name: 'gezel list', method: 'GET', path: '/api/gezels', invoke: (c) => c.listGezels() },
  {
    name: 'gezel create',
    method: 'POST',
    path: '/api/gezels',
    body: { name: 'Ada', role: 'Reviewer' },
    invoke: (c) => c.createGezel({ name: 'Ada', role: 'Reviewer' }),
  },
  {
    name: 'gezel read with escaping',
    method: 'GET',
    path: '/api/gezels/ada%2Freviewer',
    invoke: (c) => c.getGezel('ada/reviewer'),
  },
  {
    name: 'gezel rename',
    method: 'POST',
    path: '/api/gezels/ada/rename',
    body: { name: 'Grace' },
    invoke: (c) => c.renameGezel('ada', { name: 'Grace' }),
  },
  {
    name: 'session list filters',
    method: 'GET',
    path: '/api/sessions?gezel=ada%2Freviewer&project=project+one',
    invoke: (c) => c.listChatSessions({ gezelId: 'ada/reviewer', projectId: 'project one' }),
  },
  {
    name: 'session create',
    method: 'POST',
    path: '/api/sessions',
    body: { gezelId: 'ada', projectId: 'default' },
    invoke: (c) => c.createChatSession({ gezelId: 'ada', projectId: 'default' }),
  },
  {
    name: 'session send string normalization',
    method: 'POST',
    path: '/api/sessions/session%2Fone/send',
    body: { message: 'hello' },
    invoke: (c) => c.sendToChatSession('session/one', 'hello'),
  },
  {
    name: 'session archive',
    method: 'POST',
    path: '/api/sessions/session%2Fone/archive',
    invoke: (c) => c.archiveChatSession('session/one'),
  },
  {
    name: 'session delete',
    method: 'DELETE',
    path: '/api/sessions/session%2Fone',
    invoke: (c) => c.deleteChatSession('session/one'),
  },
  {
    name: 'question list filters',
    method: 'GET',
    path: '/api/questions?project=project+one&pending=true',
    invoke: (c) => c.listQuestions({ projectId: 'project one', pending: true }),
  },
  {
    name: 'memory day read',
    method: 'GET',
    path: '/api/memory/day?scope=project&id=project%2Fone&day=2026-07-15',
    invoke: (c) => c.readMemoryDay('project', 'project/one', '2026-07-15'),
  },
  {
    name: 'project list rollup',
    method: 'GET',
    path: '/api/projects?rollup=1',
    invoke: (c) => c.listProjects({ rollup: true }),
  },
  {
    name: 'project create',
    method: 'POST',
    path: '/api/projects',
    body: { name: 'Project One' },
    invoke: (c) => c.createProject({ name: 'Project One' }),
  },
  {
    name: 'project read with escaping',
    method: 'GET',
    path: '/api/projects/project%2Fone',
    invoke: (c) => c.getProject('project/one'),
  },
  {
    name: 'project update',
    method: 'PUT',
    path: '/api/projects/project%2Fone',
    body: { description: 'Updated' },
    invoke: (c) => c.updateProject('project/one', { description: 'Updated' }),
  },
  { name: 'remote list', method: 'GET', path: '/api/remotes', invoke: (c) => c.listRemotes() },
  {
    name: 'remote inspect',
    method: 'POST',
    path: '/api/remotes/inspect',
    body: { baseUrl: 'https://remote.example' },
    invoke: (c) => c.inspectRemote({ baseUrl: 'https://remote.example' }),
  },
  {
    name: 'remote unpair',
    method: 'DELETE',
    path: '/api/remotes/remote%2Fone',
    invoke: (c) => c.unpairRemote('remote/one'),
  },
];

describe('GezelClient HTTP contract', () => {
  it.each(cases)('$name maps to $method $path', async (contract) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new GezelClient({
      baseUrl: 'http://test',
      token: 'secret',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await contract.invoke(client);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://test${contract.path}`);
    expect(init.method).toBe(contract.method);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
    if (contract.body === undefined) {
      expect(init.body).toBeUndefined();
    } else {
      expect(JSON.parse(String(init.body))).toEqual(contract.body);
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    }
  });
});
