import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type JSX, useEffect, useState } from 'react';
import { SLASH_COMMAND_WORDWHEEL_SIZE, suggestSlashCommands } from '../commands.js';
import { EnginePill } from './EnginePill.js';

/**
 * The bottom input row. The status segment shows the current project
 * (folder name), the active gezel (name + role, or role only in boring
 * mode), the optional active task, and the engine pill. The prefix flips
 * with the mode so it's obvious whether Enter sends a prompt or runs a
 * command.
 */
export function PromptLine(props: {
  projectName: string;
  gezelLabel: string;
  taskRef: string | undefined;
  mode: 'chat' | 'cli';
  provider: string | undefined;
  model: string | undefined;
  busy: boolean;
  statusLabel?: string | undefined;
  value: string;
  active: boolean;
  history: ReadonlyArray<string>;
  pendingPrompt?: string | undefined;
  pendingMode?: 'text' | 'password' | 'yes-no' | undefined;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}): JSX.Element {
  const {
    projectName,
    gezelLabel,
    taskRef,
    mode,
    provider,
    model,
    busy,
    statusLabel,
    value,
    active,
    history,
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
  const suggestions = active && !pendingPrompt ? suggestSlashCommands(value) : [];
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
    onSubmit(selected ? `/${selected.name}` : submittedValue);
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
          if (selected) changeValue(`/${selected.name} `);
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
        {taskRef ? (
          <>
            <Text dimColor> · </Text>
            <Text color="yellow">{taskRef}</Text>
          </>
        ) : null}
        <Text> </Text>
        <EnginePill provider={provider} model={model} busy={busy} label={statusLabel} />
      </Box>
      {visibleSuggestions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {visibleSuggestions.map((command, windowIndex) => {
            const index = suggestionWindowStart + windowIndex;
            const selected = index === activeSuggestionIndex;
            return (
              <Text key={command.name} color={selected ? 'cyan' : undefined}>
                {selected ? '› ' : '  '}/{command.name}
                <Text dimColor> — {command.description}</Text>
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
