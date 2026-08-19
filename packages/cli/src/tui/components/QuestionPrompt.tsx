import type { AnswerQuestionRequest, NpmInstallApprovalDecision, Question } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type JSX, useState } from 'react';
import {
  allowsWriteIn,
  choicesForQuestion,
  npmApprovalPackages,
  questionHeading,
  questionOptionCount,
} from '../question-presentation.js';

export { questionOptionCount };

export const QUESTION_OPTION_WINDOW_SIZE = 4;

type QuestionOption =
  | { kind: 'choice'; choiceIndex: number; label: string }
  | { kind: 'write-in'; label: string }
  | { kind: 'submit'; label: string };

interface QuestionPromptProps {
  client: GezelClient;
  question: Question;
  askerLabel: string;
  active: boolean;
  onAnswered: (question: Question) => void;
}

/**
 * Inline answer surface for model-authored questions and service-owned
 * approvals. It owns keyboard focus while visible so normal chat input cannot
 * accidentally answer the wrong session.
 */
export function QuestionPrompt(props: QuestionPromptProps): JSX.Element {
  if (props.question.intent?.kind === 'npm-install-approval') {
    return <NpmInstallApprovalPrompt {...props} />;
  }
  return <StandardQuestionPrompt {...props} />;
}

function StandardQuestionPrompt(props: QuestionPromptProps): JSX.Element {
  const { client, question, askerLabel, active, onAnswered } = props;
  const choices = choicesForQuestion(question);
  const allowWriteIn = allowsWriteIn(question);
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

  const submit = async (body: AnswerQuestionRequest) => {
    if (submitting) return;
    if (
      !body.writeIn &&
      (!body.selectedChoices || body.selectedChoices.length === 0) &&
      body.declined !== true &&
      body.silentSkip !== true
    ) {
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
        if (key.escape) {
          if (choices.length > 0) {
            setWriting(false);
            setError(null);
          } else {
            void submit({ silentSkip: true });
          }
        }
        return;
      }
      if (key.escape) {
        void submit({ silentSkip: true });
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
        {questionHeading(question, askerLabel)}
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
          <Text dimColor>
            Enter submit{choices.length > 0 ? ' · Esc return to choices' : ' · Esc skip'}
          </Text>
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
            {' · Esc skip'}
          </Text>
        </>
      )}
      {submitting ? <Text color="yellow">Submitting…</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

type NpmDecision = NpmInstallApprovalDecision['decision'];

const NPM_DECISIONS: ReadonlyArray<{ value: NpmDecision; label: string }> = [
  { value: 'install', label: 'Install' },
  { value: 'always', label: 'Always allow' },
  { value: 'decline', label: 'Decline' },
];

function NpmInstallApprovalPrompt(props: QuestionPromptProps): JSX.Element {
  const { client, question, active, onAnswered } = props;
  const packages = npmApprovalPackages(question);
  const [packageIndex, setPackageIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [decisions, setDecisions] = useState<Array<NpmDecision | undefined>>(() =>
    packages.map(() => undefined),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentPackage = packages[packageIndex];

  const answer = async (body: AnswerQuestionRequest) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      onAnswered(await client.answerQuestion(question.id, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const submit = (nextDecisions: Array<NpmDecision | undefined>) => {
    const body: AnswerQuestionRequest =
      packages.length === 0
        ? { declined: true }
        : {
            npmInstallDecisions: packages.map((entry, index) => ({
              package: entry.package,
              version: entry.version,
              decision: nextDecisions[index] ?? 'decline',
            })),
          };
    void answer(body);
  };

  useInput(
    (_input, key) => {
      if (submitting) return;
      if (key.escape) {
        void answer({ silentSkip: true });
        return;
      }
      if (!currentPackage) {
        if (key.return) submit([]);
        return;
      }
      if (key.upArrow) {
        setOptionIndex((index) => (index <= 0 ? NPM_DECISIONS.length - 1 : index - 1));
        return;
      }
      if (key.downArrow) {
        setOptionIndex((index) => (index >= NPM_DECISIONS.length - 1 ? 0 : index + 1));
        return;
      }
      if (key.leftArrow && packageIndex > 0) {
        const previousIndex = packageIndex - 1;
        const previousDecision = decisions[previousIndex];
        setPackageIndex(previousIndex);
        setOptionIndex(
          Math.max(
            0,
            NPM_DECISIONS.findIndex((item) => item.value === previousDecision),
          ),
        );
        setError(null);
        return;
      }
      if (!key.return) return;

      const decision = NPM_DECISIONS[optionIndex]?.value ?? 'decline';
      const nextDecisions = decisions.slice();
      nextDecisions[packageIndex] = decision;
      setDecisions(nextDecisions);
      if (packageIndex >= packages.length - 1) {
        submit(nextDecisions);
        return;
      }
      const nextPackageIndex = packageIndex + 1;
      const nextDecision = nextDecisions[nextPackageIndex];
      setPackageIndex(nextPackageIndex);
      setOptionIndex(
        Math.max(
          0,
          NPM_DECISIONS.findIndex((item) => item.value === nextDecision),
        ),
      );
      setError(null);
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        npm package approval
      </Text>
      {currentPackage ? (
        <>
          <Text wrap="wrap">
            A gezel wants to install {packages.length === 1 ? 'this package' : 'packages'} outside
            the pre-vetted list.
          </Text>
          <Text>
            <Text bold>
              {currentPackage.package}@{currentPackage.version}
            </Text>
            {packages.length > 1 ? ` · package ${packageIndex + 1}/${packages.length}` : ''}
          </Text>
          {NPM_DECISIONS.map((option, index) => {
            const focused = index === optionIndex;
            const selected = decisions[packageIndex] === option.value;
            return (
              <Text key={option.value} color={focused ? 'cyan' : undefined}>
                {focused ? '› ' : '  '}
                {selected ? '[x] ' : ''}
                {option.label}
              </Text>
            );
          })}
          <Text dimColor>
            ↑/↓ choose · Enter answer{packageIndex > 0 ? ' · ← previous package' : ''}
            {' · Esc skip'}
          </Text>
        </>
      ) : (
        <>
          <Text color="red">This approval has no package details.</Text>
          <Text color="cyan">› Decline and dismiss</Text>
          <Text dimColor>Enter dismiss · Esc skip</Text>
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
