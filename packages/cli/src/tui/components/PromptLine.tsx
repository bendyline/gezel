import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type JSX, useEffect, useState } from 'react';
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
  useEffect(() => {
    setCursor(history.length);
  }, [history.length]);
  useInput(
    (_input, key) => {
      if (pendingPrompt) return; // don't recall history while answering a prompt
      if (key.upArrow && history.length > 0) {
        const next = Math.max(0, cursor - 1);
        setCursor(next);
        onChange(history[next] ?? '');
      } else if (key.downArrow && cursor < history.length) {
        const next = cursor + 1;
        setCursor(next);
        onChange(next === history.length ? '' : (history[next] ?? ''));
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
        <EnginePill provider={provider} busy={busy} label={statusLabel} />
      </Box>
      <Box>
        <Text color={pendingPrompt ? 'yellow' : mode === 'cli' ? 'green' : 'cyan'}>{prefix}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={active}
          mask={pendingMode === 'password' ? '*' : undefined}
          placeholder={placeholder}
        />
      </Box>
    </Box>
  );
}
