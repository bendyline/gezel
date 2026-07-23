import type { ToolsetCategory } from '@bendyline/gezel';

/**
 * ─ Toolset auto-categorization ──────────────────────────────────────
 *
 * Maps a toolset to one of `ToolsetCategorySchema`'s buckets via
 * keyword heuristics over its name + description + tags + maintainer
 * + id. Used at catalog index-build time to backfill the 3,800+
 * community manifests that ship with no manual category, and at
 * runtime by the `BundledSource` slow-path when no `index.json` is
 * present.
 *
 * The heuristic is intentionally simple — token overlap with a small
 * keyword dictionary, with categories tried in priority order. It
 * will miscategorize ~5-10% of entries; that's acceptable for V1
 * because:
 *
 *   1. The user can already filter by free text inside any category.
 *   2. Identity manifests can pin `category` manually to override.
 *   3. The alternative (hand-curating 3,800 entries) isn't worth it.
 *
 * Category order matters when multiple buckets match — earlier wins.
 * That's why "search" comes before "ai" (a search-focused MCP that
 * mentions "AI-powered" should still land in `search`, not `ai`).
 */

interface CategoryRule {
  category: ToolsetCategory;
  /**
   * Lowercase substrings. Matched as substrings, not whole words, to
   * keep the rule list short — false positives ("github" matching
   * "subgithub") are rare enough not to be worth the regex tax.
   */
  keywords: string[];
}

const RULES: CategoryRule[] = [
  {
    category: 'search',
    keywords: [
      'search',
      'scrape',
      'scraping',
      'crawl',
      'crawler',
      'web fetch',
      'web search',
      'lookup',
      'duckduckgo',
      'serpapi',
      'tavily',
      'brave search',
      'exa-',
      'perplexity',
      'kagi',
      'searxng',
    ],
  },
  {
    category: 'dev-tools',
    keywords: [
      'github',
      'gitlab',
      'bitbucket',
      'sentry',
      'pull request',
      'pull-request',
      'issue tracker',
      'code review',
      'lint',
      'test runner',
      'devops',
      'ci/cd',
      'jenkins',
      'circleci',
      'github actions',
      'pagerduty',
      'datadog',
      'logs ',
      'monitoring',
      'observability',
      'apm ',
      'compiler',
      'package manager',
      'npm ',
      'pypi',
      ' pip ',
      'docker hub',
      'container registry',
      'release notes',
      'deploy',
      'deployment',
      'vercel',
      'netlify',
      'fly.io',
      'render.com',
      'heroku',
    ],
  },
  {
    category: 'data',
    keywords: [
      'database',
      'postgres',
      'postgresql',
      'mysql',
      'mariadb',
      'sqlite',
      'mongodb',
      ' mongo ',
      'redis',
      'elasticsearch',
      'opensearch',
      'clickhouse',
      'snowflake',
      'bigquery',
      'duckdb',
      'cassandra',
      'dynamodb',
      'firestore',
      'firebase',
      'supabase',
      'data warehouse',
      'data lake',
      'spreadsheet',
      'airtable',
      'data analytics',
      'metabase',
      'tableau',
      'looker',
      'csv',
      'excel ',
      'sql ',
      'graphql',
      'data pipeline',
      'etl ',
    ],
  },
  {
    category: 'cloud',
    keywords: [
      ' aws ',
      'amazon web services',
      ' s3 ',
      'ec2',
      'lambda',
      ' azure ',
      ' gcp ',
      'google cloud',
      'cloudflare',
      'kubernetes',
      ' k8s ',
      'docker',
      'containers',
      'terraform',
      'pulumi',
      'helm',
      'serverless',
      'cloud run',
      'fargate',
      'cloudformation',
      'digitalocean',
      'linode',
    ],
  },
  {
    category: 'productivity',
    keywords: [
      'calendar',
      'tasks',
      'todo',
      ' jira',
      'linear ',
      ' asana',
      'trello',
      'clickup',
      'project management',
      'task management',
      'kanban',
      'monday.com',
      'shortcut',
      'pivotaltracker',
      'basecamp',
      'time tracking',
      'pomodoro',
      'reminder',
    ],
  },
  {
    category: 'communication',
    keywords: [
      'slack',
      'discord',
      ' email',
      'gmail',
      'outlook',
      'teams ',
      'whatsapp',
      'telegram',
      'twitter',
      ' x.com',
      'linkedin',
      'mastodon',
      'bluesky',
      'reddit',
      'messaging',
      'chat ',
      'sms ',
      'twilio',
      'mailchimp',
      'mailgun',
      'sendgrid',
      'newsletter',
      'matrix',
      'rocket.chat',
    ],
  },
  {
    category: 'content',
    keywords: [
      'notion',
      ' wiki',
      'document',
      'documents',
      'docx',
      ' pdf',
      'markdown',
      'obsidian',
      'confluence',
      'cms',
      'wordpress',
      'blog',
      'medium',
      'substack',
      'ghost ',
      'translate',
      'translation',
      ' rss',
      'note-taking',
      'note taking',
      'evernote',
      'google docs',
      'sharepoint',
      'onedrive',
      'dropbox',
      'box.com',
      'file storage',
      'pdf parser',
      'docs ',
    ],
  },
  {
    category: 'media',
    keywords: [
      'image',
      'video',
      'audio',
      'photo',
      'figma',
      'sketch',
      'music',
      'render',
      'design',
      'spotify',
      'youtube',
      'vimeo',
      'soundcloud',
      'twitch',
      'streaming',
      'podcast',
      'tts ',
      'text-to-speech',
      'speech-to-text',
      'transcribe',
      'transcription',
      'whisper',
      'stable diffusion',
      'midjourney',
      'dalle',
      'dall-e',
      'flux',
      'photo editor',
      'image editor',
      'image generation',
      'image generator',
      'video generation',
    ],
  },
  {
    category: 'ai',
    keywords: [
      'llm ',
      'embedding',
      'embeddings',
      'vector db',
      'vector database',
      'vector store',
      'pinecone',
      'weaviate',
      'qdrant',
      'chroma db',
      'chromadb',
      'milvus',
      'lancedb',
      'langchain',
      'llamaindex',
      'agentic',
      'openai api',
      'anthropic api',
      ' rag ',
      'retrieval-augmented',
      'huggingface',
      'hugging face',
      'inference engine',
      'fine-tuning',
      'fine-tune',
      'prompt engineering',
      'prompt library',
      'agent framework',
      'agent orchestration',
      'multi-agent',
      'ml ops',
      'mlops',
    ],
  },
];

/**
 * Categorize a toolset by its identity-manifest fields. The order of
 * checks matches the priority order of `RULES` above.
 *
 * Inputs are lowercased and concatenated into a single haystack —
 * tokenized matching isn't worth the complexity for ~10% better
 * placement of niche entries.
 */
export function categorizeToolset(input: {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  maintainerName?: string;
}): ToolsetCategory {
  const haystack = [
    input.name,
    input.description,
    input.id,
    input.tags.join(' '),
    input.maintainerName ?? '',
  ]
    .join(' ')
    .toLowerCase();
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw)) return rule.category;
    }
  }
  return 'other';
}
