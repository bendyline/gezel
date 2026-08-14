import type { CraftbookSummary } from '@bendyline/gezel';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type JSX, useEffect, useState } from 'react';
import { SLASH_COMMAND_WORDWHEEL_SIZE, suggestSlashWordwheel } from '../commands.js';
import type { CliOpenReference } from '../open-command.js';
import { EnginePill } from './EnginePill.js';

/**
 * The bottom input row. The status segment shows the current project
 * (folder name), the active gezel (name + role, or role only in boring
 * mode), the selected thread, and the engine pill. The prefix flips
 * with the mode so it's obvious whether Enter sends a prompt or runs a
 * command.
 */
export function PromptLine(props: {
  projectName: string;
  gezelLabel: string;
  threadTitle?: string | undefined;
  mode: 'chat' | 'cli';
  provider: string | undefined;
  model: string | undefined;
  accessMode: string | undefined;
  busy: boolean;
  statusLabel?: string | undefined;
  value: string;
  active: boolean;
  history: ReadonlyArray<string>;
  craftbooks: ReadonlyArray<CraftbookSummary>;
  recentOpenReferences: ReadonlyArray<CliOpenReference>;
  pendingPrompt?: string | undefined;
  pendingMode?: 'text' | 'password' | 'yes-no' | undefined;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}): JSX.Element {
  const {
    projectName,
    gezelLabel,
    threadTitle,
    mode,
    provider,
    model,
    accessMode,
    busy,
    statusLabel,
    value,
    active,
    history,
    craftbooks,
    recentOpenReferences,
    pendingPrompt,
    pendingMode,
    onChange,
    onSubmit,
  } = props;

  // Readline-style history. The cursor sits one past the newest entry
  // (= the "live" draft line); ↑ walks back, ↓ walks forward to the draft.
  // Resets to the end whenever a new line lands in history.
  const [cursor, setCursor] = useState(history.length);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const suggestions =
    active && !pendingPrompt ? suggestSlashWordwheel(value, craftbooks, recentOpenReferences) : [];
  const activeSuggestionIndex = Math.min(suggestionIndex, Math.max(0, suggestions.length - 1));
  const suggestionWindowStart = Math.min(
    Math.max(0, activeSuggestionIndex - SLASH_COMMAND_WORDWHEEL_SIZE + 1),
    Math.max(0, suggestions.length - SLASH_COMMAND_WORDWHEEL_SIZE),
  );
  const visibleSuggestions = suggestions.slice(
    suggestionWindowStart,
    suggestionWindowStart + SLASH_COMMAND_WORDWHEEL_SIZE,
  );
  const changeValue = (nextValue: string) => {
    setSuggestionIndex(0);
    onChange(nextValue);
  };
  const submitValue = (submittedValue: string) => {
    const selected = suggestions[activeSuggestionIndex];
    onSubmit(selected ? selected.submit : submittedValue);
  };

  useEffect(() => {
    setCursor(history.length);
  }, [history.length]);
  useInput(
    (_input, key) => {
      if (suggestions.length > 0) {
        if (key.upArrow) {
          setSuggestionIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
          return;
        }
        if (key.downArrow) {
          setSuggestionIndex((i) => (i >= suggestions.length - 1 ? 0 : i + 1));
          return;
        }
        if (key.tab) {
          const selected = suggestions[activeSuggestionIndex];
          if (selected) changeValue(selected.completion);
          return;
        }
      }
      if (pendingPrompt) return; // don't recall history while answering a prompt
      if (key.upArrow && history.length > 0) {
        const next = Math.max(0, cursor - 1);
        setCursor(next);
        changeValue(history[next] ?? '');
      } else if (key.downArrow && cursor < history.length) {
        const next = cursor + 1;
        setCursor(next);
        changeValue(next === history.length ? '' : (history[next] ?? ''));
      }
    },
    { isActive: active },
  );

  const prefix = pendingPrompt ? '↳ ' : mode === 'cli' ? '$ ' : '› ';
  const placeholder = pendingPrompt
    ? pendingPrompt
    : mode === 'cli'
      ? 'shell / @tool … (/chat to exit)'
      : 'message, or /command, !shell, @tool';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="blue">{projectName}</Text>
        <Text dimColor> · </Text>
        <Text color="magenta">{gezelLabel}</Text>
        {threadTitle ? (
          <>
            <Text dimColor> · </Text>
            <Text color="cyan">↳ {compactThreadTitle(threadTitle)}</Text>
          </>
        ) : null}
        <Text> </Text>
        <EnginePill
          provider={provider}
          model={model}
          accessMode={accessMode}
          busy={busy}
          label={statusLabel}
        />
      </Box>
      {visibleSuggestions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {visibleSuggestions.map((suggestion, windowIndex) => {
            const index = suggestionWindowStart + windowIndex;
            const selected = index === activeSuggestionIndex;
            return (
              <Text key={suggestion.key} color={selected ? 'cyan' : undefined}>
                {selected ? '› ' : '  '}
                {suggestion.label}
                <Text dimColor> — {suggestion.description}</Text>
              </Text>
            );
          })}
          <Text dimColor>
            ↑/↓ choose · Enter run · Tab complete
            {suggestions.length > SLASH_COMMAND_WORDWHEEL_SIZE
              ? ` · ${activeSuggestionIndex + 1}/${suggestions.length}`
              : ''}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color={pendingPrompt ? 'yellow' : mode === 'cli' ? 'green' : 'cyan'}>{prefix}</Text>
        <TextInput
          value={value}
          onChange={changeValue}
          onSubmit={submitValue}
          focus={active}
          mask={pendingMode === 'password' ? '*' : undefined}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  );
}

function compactThreadTitle(title: string): string {
  const display = title === 'New session' ? 'New thread' : title;
  return display.length > 32 ? `${display.slice(0, 31)}…` : display;
}
