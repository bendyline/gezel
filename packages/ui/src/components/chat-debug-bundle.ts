import type { SessionDebugSnapshot } from '@bendyline/gezel';

/**
 * Pick a fence string that's strictly longer than any backtick run
 * inside `content`, so a code block wrapping that content can't be
 * prematurely terminated by an inner fence. CommonMark says a fenced
 * block opened with N backticks closes only on a line of N or more
 * backticks; using more than the max-inner run is the safe shape.
 *
 * Without this the debug bundle's system-prompt section gets eaten by
 * its own contents — the system prompt has triple-backtick examples,
 * the bundle wraps it in triple-backticks, and the first inner ```
 * closes the outer fence. Everything after it renders as raw
 * markdown, which then mangles `_underscore_names_` into italics.
 */
function pickCodeFence(content: string): string {
  let maxRun = 0;
  let current = 0;
  for (const ch of content) {
    if (ch === '`') {
      current += 1;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

function pushFenced(lines: string[], content: string): void {
  const fence = pickCodeFence(content);
  lines.push(fence);
  lines.push(content);
  lines.push(fence);
}

/**
 * Format a debug snapshot into a markdown bundle suitable for pasting
 * into another chat or a bug report. Sections are heavy-headed so a
 * reader scanning the dump can find the system prompt, the response
 * being investigated, and the recent thread without searching. The
 * response is surfaced FIRST after the metadata so it's the first
 * thing the receiving conversation reads — the system prompt and
 * thread are context.
 */
export function formatDebugBundle(opts: {
  snapshot: SessionDebugSnapshot;
  response: string;
}): string {
  const s = opts.snapshot;
  const lines: string[] = [];
  lines.push('# Gezel debug bundle');
  lines.push('');
  lines.push(`Generated: ${s.generatedAt}`);
  lines.push('');
  lines.push('## Model + session');
  lines.push('');
  lines.push(`- Provider: \`${s.providerName}\``);
  if (s.model) lines.push(`- Model: \`${s.model}\``);
  lines.push(`- Tier: \`${s.modelTier}\``);
  if (s.parameterSize) lines.push(`- Parameter size: \`${s.parameterSize}\``);
  lines.push(`- Verbose family (leaks reasoning): \`${s.leaksUntaggedReasoning}\``);
  if (s.reasoningEffort) lines.push(`- Reasoning effort: \`${s.reasoningEffort}\``);
  if (s.numCtx) lines.push(`- num_ctx: \`${s.numCtx}\``);
  lines.push(`- Session: \`${s.sessionId}\``);
  lines.push(`- Turn status at export: \`${s.turnStatus}\``);
  if (s.externalConversation) {
    lines.push(
      `- Conversation owner: **${s.externalConversation.appName}** (caller-owned prompt and tool loop; Gezel is a read-only mirror)`,
    );
    if (s.externalConversation.workingDirectory) {
      lines.push(`- Caller working directory: \`${s.externalConversation.workingDirectory}\``);
    }
    if (s.externalConversation.request) {
      lines.push(`- Caller request captured: \`${s.externalConversation.request.capturedAt}\``);
    }
  }
  if (s.registeredTools.length > 0) {
    const scope =
      s.registeredToolsSource === 'persisted'
        ? ', last known'
        : s.registeredToolsSource === 'caller'
          ? `, supplied by ${s.externalConversation?.appName ?? 'caller'}`
          : '';
    lines.push(
      `- Registered tools (${s.registeredTools.length}${scope}): ${s.registeredTools.map((t) => `\`${t}\``).join(', ')}`,
    );
  } else if (s.registeredToolsSource === 'live') {
    lines.push('- Registered tools: **none** (live session reported an empty bridge)');
  } else if (s.registeredToolsSource === 'caller') {
    lines.push('- Registered tools: **none** (captured caller request supplied no functions)');
  } else {
    // Never assert "none" without having asked a live bridge. An empty
    // list from a cold session is missing evidence, not evidence of a
    // missing roster — and reading it as the latter cost one whole
    // investigation, on a bundle whose own prompt listed ~80 tools.
    // Older snapshots carry no source at all; they land here too.
    lines.push(
      '- Registered tools: **not recorded** (no live session at export — unknown, NOT an empty roster; read the "Tools available this turn" block in the prompt below)',
    );
  }
  if (s.registeredToolsSource === 'caller') {
    lines.push('- Tools listing source: caller-supplied OpenAI-compatible `tools[]`');
  } else if (s.customToolsMd) {
    lines.push(
      '- Tools listing source: **custom `tools.md`** (auto-injected listing fully replaced; gezel owner is responsible for accuracy)',
    );
  } else {
    lines.push('- Tools listing source: auto-injected from registered MCP bridge tools');
  }
  lines.push('');
  lines.push('## Response under investigation');
  lines.push('');
  const response = opts.response.trim();
  if (!response && s.turnStatus !== 'idle') {
    lines.push(
      `> This turn was still ${s.turnStatus} when the bundle was exported. An empty block below is not a completed empty model response.`,
    );
    lines.push('');
  }
  pushFenced(lines, response);
  lines.push('');
  lines.push(
    s.externalConversation
      ? s.externalConversation.request
        ? `## System prompt (captured from ${s.externalConversation.appName} request)`
        : '## System prompt (not captured for this older external mirror)'
      : '## System prompt (freshly computed)',
  );
  lines.push('');
  pushFenced(lines, s.systemPrompt.trim());
  lines.push('');
  if (s.volatileContext && s.volatileContext.trim().length > 0) {
    lines.push('## Volatile context (task/step layer, second system message)');
    lines.push('');
    pushFenced(lines, s.volatileContext.trim());
    lines.push('');
  }
  const externalRequest = s.externalConversation?.request;
  if (externalRequest) {
    lines.push(
      `## Caller-owned request transcript (${externalRequest.transcript.length} of ${externalRequest.messageCount} messages)`,
    );
    lines.push('');
    if (externalRequest.transcriptTruncated) {
      lines.push('> This diagnostic copy was bounded; the owning app remains authoritative.');
      lines.push('');
    }
    for (const message of externalRequest.transcript) {
      const id = message.toolCallId ? ` (tool_call_id: ${message.toolCallId})` : '';
      lines.push(`### ${message.role}${id}`);
      lines.push('');
      pushFenced(lines, message.content.trim());
      for (const call of message.toolCalls ?? []) {
        lines.push('');
        lines.push(`Tool call \`${call.name}\` (\`${call.id}\`) arguments:`);
        lines.push('');
        pushFenced(lines, call.arguments);
      }
      lines.push('');
    }
    if (externalRequest.actionLedger) {
      lines.push('## Action ledger injected into the completion');
      lines.push('');
      pushFenced(lines, externalRequest.actionLedger);
      lines.push('');
    }
  }
  lines.push(`## Recent messages (${s.recentMessages.length})`);
  lines.push('');
  for (const m of s.recentMessages) {
    const roleHeader = m.synthetic ? `${m.role} (synthetic: ${m.synthetic})` : m.role;
    lines.push(`### ${roleHeader}`);
    lines.push('');
    pushFenced(lines, m.content.trim());
    if (m.reasoning && m.reasoning.trim().length > 0) {
      lines.push('');
      lines.push('Reasoning (captured from `<|channel|>` / `<think>` blocks):');
      lines.push('');
      pushFenced(lines, m.reasoning.trim());
    }
    if (m.warnings && m.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      for (const w of m.warnings) {
        lines.push(`- ${w}`);
      }
    }
    if (m.attemptedToolCalls && m.attemptedToolCalls.length > 0) {
      lines.push('');
      lines.push(
        'Attempted tool calls (salvage failed — these are the literal shapes the model emitted):',
      );
      for (const a of m.attemptedToolCalls) {
        if (a.reason) {
          lines.push(`- reason: ${a.reason.replace(/\n/g, ' ')}`);
        }
        lines.push('  body:');
        // Indented fenced block. `pickCodeFence` returns a backtick
        // run strictly longer than anything inside the body, so a
        // fabricated body containing triple-backticks can't terminate
        // the wrapping fence.
        const fence = pickCodeFence(a.body);
        lines.push(`  ${fence}`);
        for (const ln of a.body.split('\n')) lines.push(`  ${ln}`);
        lines.push(`  ${fence}`);
      }
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      lines.push('');
      lines.push('Tool calls:');
      for (const tc of m.toolCalls) {
        const args = tc.argsSummary ? ` ${tc.argsSummary}` : '';
        const status = tc.success ? 'ok' : 'failed';
        lines.push(`- \`${tc.name}\`${args} — ${status}`);
        if (!tc.success && tc.errorMessage) {
          const truncated =
            tc.errorMessage.length > 400 ? `${tc.errorMessage.slice(0, 400)}…` : tc.errorMessage;
          lines.push(`  - error: ${truncated.replace(/\n/g, ' ')}`);
        }
      }
    }
    lines.push('');
  }
  if (s.diagnostics) {
    const d = s.diagnostics;
    lines.push('## Where to dig deeper');
    lines.push('');
    lines.push(
      "When the bundle isn't enough, these on-disk sources have the full picture the bundle samples:",
    );
    lines.push('');
    lines.push(
      s.externalConversation
        ? `- **Gezel mirror record** (normalized completed turns; ${s.externalConversation.appName} owns the authoritative transcript and intermediate tool loop): \`${d.sessionRecordPath}\``
        : `- **Session transcript** (every turn, tool call, reasoning): \`${d.sessionRecordPath}\``,
    );
    lines.push(`- **Logs directory** (daemon + engine): \`${d.logsDir}\``);
    if (d.engineLogGlob) {
      lines.push(
        `- **Engine log** (model load, SSE lifecycle, crashes): \`${d.logsDir}/${d.engineLogGlob}\` (today's file by date)`,
      );
    }
    lines.push(
      `- **Grep the daemon log for this session:** \`grep ${s.sessionId.slice(0, 8)} ${d.logsDir}/*.log\``,
    );
    lines.push('');
  }
  return lines.join('\n');
}
