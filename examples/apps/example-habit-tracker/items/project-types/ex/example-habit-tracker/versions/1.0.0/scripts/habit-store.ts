import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'habit-store',
  description: 'Add habits and log daily check-ins in habits.json.',
  kind: 'action',
  inputs: {
    action: { type: 'string', description: "'add' or 'log'.", default: 'log' },
    name: { type: 'string', description: 'Habit name.', default: '' },
  },
  outputs: {
    habits: { type: 'json', description: 'Every habit with its check-in log.' },
    logged: { type: 'string', description: 'The habit that was just logged, if any.' },
  },
  requires: ['workspace.read', 'workspace.write'],
} as const);

interface HabitFile {
  habits: Array<{ name: string; log: string[] }>;
}

const input = gezel.input as InferredInput<typeof meta>;
const raw = await gezel.fs.read('habits.json').catch(() => '{"habits":[]}');
const data = JSON.parse(raw) as HabitFile;
let logged = '';
if (input.action === 'add' && input.name && !data.habits.some((h) => h.name === input.name)) {
  data.habits.push({ name: input.name, log: [] });
}
if (input.action === 'log' && input.name) {
  const habit = data.habits.find((h) => h.name === input.name);
  if (habit) {
    habit.log.push(new Date().toISOString().slice(0, 10));
    logged = habit.name;
  }
}
if (logged || input.action === 'add') {
  await gezel.fs.write('habits.json', JSON.stringify(data, null, 2));
}
gezel.output({ habits: data.habits, logged });
