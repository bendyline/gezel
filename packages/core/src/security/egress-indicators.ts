/**
 * Lexical indicators that a tool call reaches somewhere no gezel has a
 * reason to go: a cloud metadata service, a link-local address, a known
 * data-drop or tunnel host, or a Linux namespace tool.
 *
 * WHY: Cohere caught an open-weight model that, given a shell, sometimes
 * ran an unrequested `curl PUT` to an Alibaba Cloud bucket, reached for
 * `169.254.169.254`, and tried `unshare -Urm` — while its reasoning said it
 * would call no tools (cohere.com/blog/concerning-behaviour-popular-open-weight-ai-model,
 * October 2026). The reasoning trace is no boundary, so the check runs on
 * the call itself, before it runs.
 *
 * This is a tripwire, not a sandbox. It is lexical and easy to evade on
 * purpose; it targets trained-in habits, which are not obfuscated. It
 * deliberately leaves loopback and private addresses alone — a coding agent
 * curls its own dev server and reaches machines on the LAN every day — and
 * it runs only where a call executes or fetches, never on text a gezel
 * writes into a file, so a security report may still quote these hosts.
 */

export type EgressIndicatorKind =
  | 'cloud-metadata'
  | 'link-local'
  | 'watchlist-host'
  | 'namespace-escape';

export interface EgressIndicator {
  kind: EgressIndicatorKind;
  /** The text that matched, lowercased, e.g. `169.254.169.254` or `webhook.site`. */
  match: string;
}

const CLOUD_METADATA_IPS = new Set([
  '169.254.169.254', // AWS, Azure, GCP, Oracle, DigitalOcean, OpenStack
  '169.254.170.2', // AWS ECS task credentials
  '100.100.100.200', // Alibaba Cloud
]);
const CLOUD_METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

/**
 * Registrable domains whose whole purpose is catching requests, exposing a
 * tunnel, or dropping files for strangers. A gezel has no task-shaped reason
 * to send anything to one. Matched with every subdomain.
 */
const WATCHLIST_DOMAINS: readonly string[] = [
  // Out-of-band request capture.
  'webhook.site',
  'requestbin.net',
  'requestcatcher.com',
  'pipedream.net',
  'interact.sh',
  'oast.fun',
  'oast.live',
  'oast.me',
  'oast.online',
  'oast.pro',
  'oast.site',
  'oastify.com',
  'burpcollaborator.net',
  // Ad-hoc tunnels into someone else's machine.
  'ngrok.io',
  'ngrok.app',
  'ngrok-free.app',
  'ngrok-free.dev',
  'trycloudflare.com',
  'loca.lt',
  'serveo.net',
  // Anonymous file drops.
  'transfer.sh',
];

/** The hosts named in the Cohere report. Narrow on purpose: Alibaba Cloud storage has real users. */
function isReportedAlibabaHost(host: string): boolean {
  const label = host.split('.')[0] ?? '';
  if (label.startsWith('routify-file-proxy')) return true;
  if (!host.endsWith('.aliyuncs.com')) return false;
  return label.startsWith('routify-') || label === 'sanmaohe';
}

const IPV4 = /(?<![0-9.])(\d{1,3}(?:\.\d{1,3}){3})(?![0-9])/g;
const IPV6_METADATA = /(?<![0-9a-f:])fd00:ec2::254(?![0-9a-f:])/g;
const IPV6_LINK_LOCAL = /(?<![0-9a-f:])fe80:[0-9a-f:]*/g;
const HOSTNAME =
  /(?<![a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62})(?![a-z0-9-])/g;
/** A namespace tool invoked with an option, as a command word: `unshare -Urm`, `nsenter --target 1`. */
const NAMESPACE_TOOL = /(?<![\w./-])(unshare|nsenter)\s+-/g;

/** Every indicator in one piece of text. */
export function findEgressIndicators(text: string): EgressIndicator[] {
  const found = new Map<string, EgressIndicator>();
  const add = (kind: EgressIndicatorKind, match: string) => {
    found.set(`${kind}:${match}`, { kind, match });
  };
  const lower = text.toLowerCase();
  for (const [, ip] of lower.matchAll(IPV4)) {
    if (!ip) continue;
    const octets = ip.split('.').map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    if (CLOUD_METADATA_IPS.has(ip)) add('cloud-metadata', ip);
    else if (octets[0] === 169 && octets[1] === 254) add('link-local', ip);
  }
  for (const [match] of lower.matchAll(IPV6_METADATA)) add('cloud-metadata', match);
  for (const [match] of lower.matchAll(IPV6_LINK_LOCAL)) add('link-local', match);
  for (const [, host] of lower.matchAll(HOSTNAME)) {
    if (!host) continue;
    if (CLOUD_METADATA_HOSTS.has(host)) add('cloud-metadata', host);
    else if (isWatchlistHost(host)) add('watchlist-host', host);
  }
  for (const [, tool] of lower.matchAll(NAMESPACE_TOOL)) if (tool) add('namespace-escape', tool);
  return [...found.values()];
}

/** Text scanned per value; past it the rest is not read. Tool arguments are rarely near this. */
const MAX_SCANNED_CHARS = 4 * 1024 * 1024;

/**
 * Every indicator in a structured tool argument. Arrays of strings are also
 * scanned joined with spaces, so an argv like `["unshare", "-Urm"]` reads as
 * the command it is.
 */
export function findEgressIndicatorsInValue(value: unknown): EgressIndicator[] {
  const texts: string[] = [];
  let budget = MAX_SCANNED_CHARS;
  const take = (text: string) => {
    if (budget <= 0 || !text) return;
    const piece = text.length > budget ? text.slice(0, budget) : text;
    budget -= piece.length;
    texts.push(piece);
  };
  const walk = (node: unknown, depth: number) => {
    if (budget <= 0 || depth > 32) return;
    if (typeof node === 'string') take(node);
    else if (Array.isArray(node)) {
      if (node.length > 1 && node.every((item) => typeof item === 'string')) take(node.join(' '));
      for (const item of node) walk(item, depth + 1);
    } else if (node && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  const found = new Map<string, EgressIndicator>();
  for (const text of texts) {
    for (const hit of findEgressIndicators(text)) found.set(`${hit.kind}:${hit.match}`, hit);
  }
  return [...found.values()];
}

/** True when `host` is a watchlisted domain or one of its subdomains, or a host from the report. */
export function isWatchlistHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isReportedAlibabaHost(h)) return true;
  return WATCHLIST_DOMAINS.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

const KIND_LABELS: Record<EgressIndicatorKind, string> = {
  'cloud-metadata': 'a cloud metadata service',
  'link-local': 'a link-local address',
  'watchlist-host': 'a data-drop or tunnel service',
  'namespace-escape': 'a Linux namespace tool',
};

/** `169.254.169.254` (a cloud metadata service), … — at most three, for messages. */
export function describeEgressIndicators(indicators: readonly EgressIndicator[]): string {
  const shown = indicators.slice(0, 3).map((hit) => `\`${hit.match}\` (${KIND_LABELS[hit.kind]})`);
  const more = indicators.length > 3 ? ` and ${indicators.length - 3} more` : '';
  return `${shown.join(', ')}${more}`;
}

/** Where a call was stopped: Gezel's own tool sinks, a bridged MCP toolset, or a `/v1` facade. */
export type ToolCallBlockSurface = 'gezel-tool' | 'mcp-toolset' | 'openai' | 'responses' | 'ollama';

/** The `security.tool-call-blocked` History entry for one refused call. */
export function toolCallBlockedHistoryEntry(opts: {
  tool: string;
  surface: ToolCallBlockSurface;
  indicators: readonly EgressIndicator[];
  projectId?: string;
  gezelId?: string;
  sessionId?: string;
  appId?: string;
}): {
  kind: 'security.tool-call-blocked';
  projectId?: string;
  gezelId?: string;
  summary: string;
  details: Record<string, unknown>;
} {
  const named = opts.indicators.map((hit) => hit.match).join(', ');
  return {
    kind: 'security.tool-call-blocked',
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.gezelId ? { gezelId: opts.gezelId } : {}),
    summary: `Blocked a ${opts.tool} call naming ${named}`,
    details: {
      tool: opts.tool,
      surface: opts.surface,
      indicators: opts.indicators.map((hit) => ({ kind: hit.kind, match: hit.match })),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.appId ? { appId: opts.appId } : {}),
    },
  };
}

/** The model-facing refusal. Says what matched and closes the door on retries. */
export function egressIndicatorRefusal(indicators: readonly EgressIndicator[]): string {
  return `Blocked by Gezel: this call names ${describeEgressIndicators(indicators)}. Gezel refuses tool calls that reach cloud metadata services, link-local addresses, data-drop or tunnel services, or Linux namespace tools. Do not retry it or look for another way to reach it. Continue without it, and tell the person what you meant to do.`;
}
