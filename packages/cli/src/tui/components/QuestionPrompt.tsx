import type { Question } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type JSX, useState } from 'react';

export const QUESTION_OPTION_WINDOW_SIZE = 4;

type QuestionOption =
  | { kind: 'choice'; choiceIndex: number; label: string }
  | { kind: 'write-in'; label: string }
  | { kind: 'submit'; label: string };

export function questionOptionCount(question: Question): number {
  const choices = question.choices?.length ?? 0;
  const writeIn = question.allowWriteIn ?? true;
  const submit = question.multiSelect === true && choices > 0;
  return choices + (writeIn ? 1 : 0) + (submit ? 1 : 0);
}

/**
 * Inline answer surface for a plain `ask_user_question`. It owns keyboard
 * focus while visible so normal chat input cannot accidentally answer the
 * wrong session.
 */
export function QuestionPrompt(props: {
  client: GezelClient;
  question: Question;
  askerLabel: string;
  active: boolean;
  onAnswered: (question: Question) => void;
}): JSX.Element {
  const { client, question, askerLabel, active, onAnswered } = props;
  const choices = question.choices ?? [];
  const allowWriteIn = question.allowWriteIn ?? true;
  const multiSelect = question.multiSelect === true;
  const options: QuestionOption[] = [
    ...choices.map(
      (label, choiceIndex): QuestionOption => ({ kind: 'choice', choiceIndex, label }),
    ),
    ...(allowWriteIn ? [{ kind: 'write-in' as const, label: 'Other…' }] : []),
    ...(multiSelect && choices.length > 0
      ? [{ kind: 'submit' as const, label: 'Submit selections' }]
      : []),
  ];

  const [optionIndex, setOptionIndex] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [writing, setWriting] = useState(choices.length === 0 && allowWriteIn);
  const [writeIn, setWriteIn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeOptionIndex = Math.min(optionIndex, Math.max(0, options.length - 1));
  const windowStart = Math.min(
    Math.max(0, activeOptionIndex - QUESTION_OPTION_WINDOW_SIZE + 1),
    Math.max(0, options.length - QUESTION_OPTION_WINDOW_SIZE),
  );
  const visibleOptions = options.slice(windowStart, windowStart + QUESTION_OPTION_WINDOW_SIZE);

  const submit = async (body: { selectedChoices?: number[]; writeIn?: string }) => {
    if (submitting) return;
    if (!body.writeIn && (!body.selectedChoices || body.selectedChoices.length === 0)) {
      setError('Choose an option or supply your own response.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      onAnswered(await client.answerQuestion(question.id, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const submitWriteIn = (value: string) => {
    const answer = value.trim();
    if (!answer) {
      setError('Type a response before submitting.');
      return;
    }
    void submit({
      ...(multiSelect && selected.size > 0
        ? { selectedChoices: [...selected].sort((a, b) => a - b) }
        : {}),
      writeIn: answer,
    });
  };

  useInput(
    (input, key) => {
      if (submitting) return;
      if (writing) {
        if (key.escape && choices.length > 0) {
          setWriting(false);
          setError(null);
        }
        return;
      }
      if (key.upArrow) {
        setOptionIndex((index) => (index <= 0 ? Math.max(0, options.length - 1) : index - 1));
        return;
      }
      if (key.downArrow) {
        setOptionIndex((index) => (index >= options.length - 1 ? 0 : index + 1));
        return;
      }

      const option = options[activeOptionIndex];
      if (!option) return;
      if (input === ' ' && multiSelect && option.kind === 'choice') {
        setSelected((current) => toggleSet(current, option.choiceIndex));
        return;
      }
      if (!key.return) return;
      if (option.kind === 'write-in') {
        setWriting(true);
        setError(null);
      } else if (option.kind === 'submit') {
        void submit({ selectedChoices: [...selected].sort((a, b) => a - b) });
      } else if (multiSelect) {
        setSelected((current) => toggleSet(current, option.choiceIndex));
      } else {
        void submit({ selectedChoices: [option.choiceIndex] });
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {askerLabel} asks
      </Text>
      <Text wrap="wrap">{question.prompt}</Text>
      {writing ? (
        <>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={writeIn}
              onChange={setWriteIn}
              onSubmit={submitWriteIn}
              focus={active && !submitting}
              placeholder="Type your response"
            />
          </Box>
          <Text dimColor>Enter submit{choices.length > 0 ? ' · Esc return to choices' : ''}</Text>
        </>
      ) : (
        <>
          {visibleOptions.map((option, visibleIndex) => {
            const index = windowStart + visibleIndex;
            const focused = index === activeOptionIndex;
            const checked =
              option.kind === 'choice' && multiSelect && selected.has(option.choiceIndex);
            return (
              <Text key={`${option.kind}:${option.label}`} color={focused ? 'cyan' : undefined}>
                {focused ? '› ' : '  '}
                {option.kind === 'choice' && multiSelect ? (checked ? '[x] ' : '[ ] ') : ''}
                {option.label}
              </Text>
            );
          })}
          <Text dimColor>
            ↑/↓ choose · Enter {multiSelect ? 'toggle/submit' : 'answer'}
            {multiSelect ? ' · Space toggle' : ''}
            {options.length > QUESTION_OPTION_WINDOW_SIZE
              ? ` · ${activeOptionIndex + 1}/${options.length}`
              : ''}
          </Text>
        </>
      )}
      {submitting ? <Text color="yellow">Submitting…</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

function toggleSet(current: ReadonlySet<number>, value: number): Set<number> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
