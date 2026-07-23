import { describe, expect, it } from 'vitest';
import { type AvailableToolInfo, renderAvailableToolsBlock } from './tools-block.js';

const memoryTools: AvailableToolInfo[] = [
  { name: 'search_memory', description: 'Find prior notes by query string.' },
  { name: 'save_memory', description: 'Persist a fact for future turns.' },
];
const playwrightTools: AvailableToolInfo[] = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in a Chromium session and wait for the page to load.',
  },
];
const allTools = [...memoryTools, ...playwrightTools];

describe('renderAvailableToolsBlock — tier gating', () => {
  it('renders the block for tier:tiny', () => {
    const out = renderAvailableToolsBlock({
      tools: allTools,
      modelTier: 'tiny',
      providerName: 'mlx',
    });
    expect(out).toContain('## Tools available this turn');
    expect(out).toContain('search_memory');
    expect(out).toContain('browser_navigate');
  });

  it('renders the block for tier:small and tier:medium', () => {
    expect(
      renderAvailableToolsBlock({ tools: allTools, modelTier: 'small', providerName: 'mlx' }),
    ).toContain('## Tools available this turn');
    expect(
      renderAvailableToolsBlock({ tools: allTools, modelTier: 'medium', providerName: 'mlx' }),
    ).toContain('## Tools available this turn');
  });

  it('skips for tier:large (model reads schema natively)', () => {
    expect(
      renderAvailableToolsBlock({ tools: allTools, modelTier: 'large', providerName: 'mlx' }),
    ).toBe('');
  });

  it('skips for tier:cloud', () => {
    expect(
      renderAvailableToolsBlock({ tools: allTools, modelTier: 'cloud', providerName: 'openai' }),
    ).toBe('');
  });

  it('renders when tier is unknown (treat as local)', () => {
    expect(
      renderAvailableToolsBlock({ tools: allTools, modelTier: undefined, providerName: 'ollama' }),
    ).toContain('## Tools available this turn');
  });
});

describe('renderAvailableToolsBlock — provider gating', () => {
  it('skips for providers without an MCP bridge (Copilot SDK)', () => {
    expect(
      renderAvailableToolsBlock({ tools: allTools, modelTier: 'medium', providerName: 'copilot' }),
    ).toBe('');
  });

  it('skips for the Claude CLI / Codex CLI / mock providers', () => {
    for (const providerName of ['claude-cli', 'anthropic-cli', 'codex-cli', 'mock']) {
      expect(
        renderAvailableToolsBlock({ tools: allTools, modelTier: 'medium', providerName }),
      ).toBe('');
    }
  });

  it('renders for the local bridge providers (mlx/llama-cpp/ollama)', () => {
    for (const providerName of ['mlx', 'llama-cpp', 'ollama']) {
      const out = renderAvailableToolsBlock({
        tools: allTools,
        modelTier: 'medium',
        providerName,
      });
      expect(out).toContain('## Tools available this turn');
    }
  });
});

describe('renderAvailableToolsBlock — empty input', () => {
  it('returns empty when the tool list is empty (cold session, no MCP)', () => {
    expect(renderAvailableToolsBlock({ tools: [], modelTier: 'tiny', providerName: 'mlx' })).toBe(
      '',
    );
  });

  it('returns empty when both built-in tools AND third-party toolsets are empty', () => {
    expect(
      renderAvailableToolsBlock({
        tools: [],
        thirdPartyToolsetIds: [],
        modelTier: 'tiny',
        providerName: 'mlx',
      }),
    ).toBe('');
  });
});

describe('renderAvailableToolsBlock — third-party toolsets', () => {
  it('renders an "From installed toolsets" section listing toolset ids', () => {
    const out = renderAvailableToolsBlock({
      tools: memoryTools,
      thirdPartyToolsetIds: ['@playwright/mcp', '@example/extra-mcp'],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    expect(out).toContain('### From installed toolsets');
    expect(out).toContain('@playwright/mcp');
    expect(out).toContain('@example/extra-mcp');
    // Should appear AFTER the built-in groups.
    expect(out.indexOf('### From installed toolsets')).toBeGreaterThan(out.indexOf('### Memory'));
  });

  it('renders the block when only third-party toolsets are present (no built-ins this session)', () => {
    const out = renderAvailableToolsBlock({
      tools: [],
      thirdPartyToolsetIds: ['@playwright/mcp'],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    expect(out).toContain('## Tools available this turn');
    expect(out).toContain('@playwright/mcp');
  });
});

describe('renderAvailableToolsBlock — grouping', () => {
  it('buckets built-in tools into named groups in BUILTIN_TOOLSETS order', () => {
    const out = renderAvailableToolsBlock({
      tools: [
        { name: 'write_artifact', description: 'Write an artifact.' },
        { name: 'search_memory', description: 'Find a memory.' },
      ],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    // Memory comes before Artifacts in BUILTIN_TOOLSETS (memory is
    // index 0, artifacts is index 4). Verify the rendered order.
    const memoryIdx = out.indexOf('### Memory');
    const artifactsIdx = out.indexOf('### Project Artifacts');
    expect(memoryIdx).toBeGreaterThan(0);
    expect(artifactsIdx).toBeGreaterThan(memoryIdx);
  });

  it('renders unmapped tool names under "Other tools"', () => {
    const out = renderAvailableToolsBlock({
      tools: [
        { name: 'search_memory', description: 'Find a memory.' },
        { name: 'totally_custom_user_tool', description: 'A bespoke MCP server tool.' },
      ],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    expect(out).toContain('### Memory');
    expect(out).toContain('### Other tools');
    expect(out).toContain('totally_custom_user_tool');
    // "Other tools" must come last so the model knows the structured
    // groups are the canonical surface.
    const otherIdx = out.indexOf('### Other tools');
    const memoryIdx = out.indexOf('### Memory');
    expect(otherIdx).toBeGreaterThan(memoryIdx);
  });

  it('buckets @playwright/mcp browser_* tools under "Web Access" rather than "Other tools"', () => {
    // Without this grouping, a 9B local model reading the listing
    // sees `fetch_url` / `web_search` under Web Access AND a
    // dozen `browser_*` tools dumped into a generic "Other tools"
    // bucket — small models split that into two unrelated web
    // stories and start guessing which to use. The McKinley Park
    // weather repro was exactly this failure mode.
    const out = renderAvailableToolsBlock({
      tools: [
        { name: 'fetch_url', description: 'Fetch a URL.' },
        { name: 'browser_navigate', description: 'Drive a browser.' },
        { name: 'browser_click', description: 'Click an element.' },
        // Genuinely-unrelated third-party tool — should still land in
        // "Other tools" since it doesn't match the browser heuristic.
        { name: 'totally_custom_user_tool', description: 'Bespoke.' },
      ],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    expect(out).toContain('### Web Access');
    const webIdx = out.indexOf('### Web Access');
    const browserNavIdx = out.indexOf('browser_navigate');
    const browserClickIdx = out.indexOf('browser_click');
    const fetchUrlIdx = out.indexOf('fetch_url');
    const otherIdx = out.indexOf('### Other tools');
    // All four web-ish tools land under Web Access (between the
    // Web Access heading and either the next group or Other tools).
    expect(webIdx).toBeGreaterThan(-1);
    expect(browserNavIdx).toBeGreaterThan(webIdx);
    expect(browserClickIdx).toBeGreaterThan(webIdx);
    expect(fetchUrlIdx).toBeGreaterThan(webIdx);
    expect(otherIdx).toBeGreaterThan(browserNavIdx);
    // Other tools still has the genuinely-unrelated entry.
    expect(out).toContain('totally_custom_user_tool');
  });

  it('omits empty groups (only renders groups that have tools in this session)', () => {
    const out = renderAvailableToolsBlock({
      tools: memoryTools,
      modelTier: 'medium',
      providerName: 'mlx',
    });
    expect(out).toContain('### Memory');
    // No tools from these groups — they shouldn't appear.
    expect(out).not.toContain('### Workspace');
    expect(out).not.toContain('### Project Artifacts');
  });
});

describe('renderAvailableToolsBlock — description truncation (tiny tier)', () => {
  it('keeps a short description verbatim', () => {
    const out = renderAvailableToolsBlock({
      tools: [{ name: 'save_memory', description: 'Persist a fact.' }],
      modelTier: 'tiny',
      providerName: 'mlx',
    });
    expect(out).toContain('`save_memory` — Persist a fact.');
  });

  it('truncates at the first sentence when the description has multiple sentences', () => {
    const out = renderAvailableToolsBlock({
      tools: [
        {
          name: 'save_memory',
          description:
            'Persist a fact. The runtime indexes the content for vector recall on future turns. Prefer this over saving to artifacts.',
        },
      ],
      modelTier: 'tiny',
      providerName: 'mlx',
    });
    expect(out).toContain('`save_memory` — Persist a fact.');
    // Subsequent sentences must not appear.
    expect(out).not.toContain('The runtime indexes');
    expect(out).not.toContain('Prefer this over');
  });

  it('truncates with ellipsis at the char cap when the first sentence is unreasonably long', () => {
    const long = `${'a'.repeat(300)} more text after.`;
    const out = renderAvailableToolsBlock({
      tools: [{ name: 'save_memory', description: long }],
      modelTier: 'tiny',
      providerName: 'mlx',
    });
    // The cap is 160 chars; the rendered row should be much shorter
    // than the input AND end with an ellipsis.
    const rowMatch = out.match(/`save_memory` — (.+)/);
    expect(rowMatch).not.toBeNull();
    expect(rowMatch![1]!.length).toBeLessThanOrEqual(170);
    expect(rowMatch![1]!.endsWith('…')).toBe(true);
  });

  it('handles tools with empty descriptions cleanly (just the name row)', () => {
    const out = renderAvailableToolsBlock({
      tools: [{ name: 'save_memory', description: '' }],
      modelTier: 'tiny',
      providerName: 'mlx',
    });
    expect(out).toContain('`save_memory`');
    expect(out).not.toMatch(/`save_memory` —/);
  });
});

describe('renderAvailableToolsBlock — bridge-failed override', () => {
  it('renders a hard "no tools wired" notice instead of the listing', () => {
    const out = renderAvailableToolsBlock({
      tools: [],
      modelTier: 'medium',
      providerName: 'mlx',
      bridgeFailed: true,
    });
    expect(out).toContain('MCP bridge failed');
    expect(out).toContain('function-calling schema is **empty**');
    expect(out).toContain('Do NOT emit `<tool_call>`');
    expect(out).toContain('My tool bridge failed to start');
  });

  it('renders the bridge-failed notice even for large/cloud tiers (which normally skip the block)', () => {
    // Large/cloud models read the schema natively so they normally
    // don't get the listing — but a bridge failure means the schema
    // IS empty and they ALSO need to know not to fabricate.
    const cloudOut = renderAvailableToolsBlock({
      tools: [],
      modelTier: 'cloud',
      providerName: 'openai',
      bridgeFailed: true,
    });
    expect(cloudOut).toContain('MCP bridge failed');
    const largeOut = renderAvailableToolsBlock({
      tools: [],
      modelTier: 'large',
      providerName: 'mlx',
      bridgeFailed: true,
    });
    expect(largeOut).toContain('MCP bridge failed');
  });

  it('still suppresses the block for providers without an MCP bridge (Copilot)', () => {
    // bridgeFailed shouldn't fire on providers that don't use the
    // bridge in the first place — they manage tools internally.
    const out = renderAvailableToolsBlock({
      tools: [],
      modelTier: 'medium',
      providerName: 'copilot',
      bridgeFailed: true,
    });
    expect(out).toBe('');
  });

  it('overrides the normal tools listing — listing must NOT appear when bridgeFailed is set', () => {
    // Even if (somehow) tools were passed alongside bridgeFailed, the
    // failure notice wins. Defensive: a stale `availableTools`
    // shouldn't bleed past a confirmed bridge failure.
    const out = renderAvailableToolsBlock({
      tools: [{ name: 'save_memory', description: 'Persist a fact.' }],
      modelTier: 'medium',
      providerName: 'mlx',
      bridgeFailed: true,
    });
    expect(out).toContain('MCP bridge failed');
    expect(out).not.toContain('save_memory');
  });
});

describe('renderAvailableToolsBlock — compact mode (small/medium tier)', () => {
  it('on small tier, drops per-tool descriptions and packs names per group', () => {
    const out = renderAvailableToolsBlock({
      tools: [
        { name: 'save_memory', description: 'Persist a fact for vector recall on future turns.' },
        { name: 'search_memory', description: 'Look something up.' },
      ],
      modelTier: 'small',
      providerName: 'mlx',
    });
    expect(out).toContain('### Memory');
    // Names present, descriptions absent.
    expect(out).toContain('`save_memory`');
    expect(out).toContain('`search_memory`');
    expect(out).not.toContain('Persist a fact');
    expect(out).not.toContain('Look something up');
    // Names live on a single comma-separated line per group, not as bullets.
    expect(out).not.toMatch(/^- `save_memory`$/m);
    expect(out).toMatch(/`search_memory`,\s*`save_memory`|`save_memory`,\s*`search_memory`/);
  });

  it('on medium tier, uses the same compact format', () => {
    const out = renderAvailableToolsBlock({
      tools: [{ name: 'save_memory', description: 'Persist a fact.' }],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    expect(out).toContain('`save_memory`');
    expect(out).not.toContain('Persist a fact');
  });

  it('adds workspace-vs-artifact guidance when both surfaces are present', () => {
    const out = renderAvailableToolsBlock({
      tools: [
        { name: 'readFile', description: 'Read a workspace file.' },
        { name: 'read_artifact', description: 'Read an artifact.' },
        { name: 'write_artifact', description: 'Write an artifact.' },
      ],
      modelTier: 'small',
      providerName: 'mlx',
    });
    expect(out).toContain('### Workspace vs Artifacts');
    expect(out).toContain('Workspace paths from "Workspace files" use `readFile`');
    expect(out).toContain('Artifacts are a separate drawer');
    expect(out).toContain(
      '`write_artifact({ path: "packages/...", content: "..." })` does not edit the workspace',
    );
    // Do not introduce unavailable workspace-write tools into read-only roles.
    expect(out).not.toContain('`writeFile`');
  });

  it('uses a shorter framing sentence on compact tiers', () => {
    const out = renderAvailableToolsBlock({
      tools: [{ name: 'save_memory', description: 'x' }],
      modelTier: 'medium',
      providerName: 'mlx',
    });
    // The verbose two-sentence framing should not appear; the short one should.
    expect(out).not.toContain('Every entry is real and callable; check your function schema');
    expect(out).toContain('Tools wired this turn');
  });
});

describe('renderAvailableToolsBlock — custom tools.md override', () => {
  it('replaces the auto-rendered listing with the custom markdown verbatim', () => {
    const custom = '- always call `search_memory` first.\n- never call `save_memory` mid-thought.';
    const out = renderAvailableToolsBlock({
      tools: allTools,
      modelTier: 'medium',
      providerName: 'mlx',
      customMarkdown: custom,
    });
    expect(out).toContain('## Tools available this turn');
    expect(out).toContain(custom);
    // The auto-rendered grouping should be absent.
    expect(out).not.toContain('### Memory');
    expect(out).not.toContain('### Other tools');
  });

  it('still renders for tier:large when a custom tools.md is supplied (power-user opt-in)', () => {
    const custom = '- prefer `web_search` over scraping.';
    const out = renderAvailableToolsBlock({
      tools: allTools,
      modelTier: 'large',
      providerName: 'mlx',
      customMarkdown: custom,
    });
    expect(out).toContain('## Tools available this turn');
    expect(out).toContain(custom);
  });

  it('still renders even for providers without a bridge when a custom tools.md is supplied', () => {
    const custom = '- you only have built-in Copilot tools.';
    const out = renderAvailableToolsBlock({
      tools: [],
      modelTier: 'cloud',
      providerName: 'copilot',
      customMarkdown: custom,
    });
    expect(out).toContain(custom);
  });

  it('falls through to the auto-render when customMarkdown is whitespace-only', () => {
    const out = renderAvailableToolsBlock({
      tools: allTools,
      modelTier: 'medium',
      providerName: 'mlx',
      customMarkdown: '   \n\t\n  ',
    });
    expect(out).toContain('### Memory');
  });

  it('falls through to the auto-render when customMarkdown is null', () => {
    const out = renderAvailableToolsBlock({
      tools: allTools,
      modelTier: 'medium',
      providerName: 'mlx',
      customMarkdown: null,
    });
    expect(out).toContain('### Memory');
  });
});
