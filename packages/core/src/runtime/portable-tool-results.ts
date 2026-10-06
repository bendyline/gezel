import { normalizeArtifactPath } from '../path-rules.js';
import type { WorkspaceReadFileSuccess } from '../schemas/api.js';
import type { ChatSession } from '../schemas/session.js';
import type { Task, TaskNote } from '../schemas/task.js';
import {
  ASK_USER_QUESTION_EMPTY_TEXT,
  type AdvanceGateOutcome,
  type SearchCraftbookSuggestion,
  type SearchResultRow,
  addGezelToProjectText,
  advanceGateFailureText,
  advanceTaskStepText,
  appendedText,
  artifactCompletionHint,
  askUserQuestionText,
  createTaskText,
  editedText,
  formatWorkspaceRead,
  getScriptRunText,
  getTaskText,
  listArtifactsText,
  listDirMissingText,
  listDirText,
  listDocumentsText,
  listGezelsText,
  listGildeText,
  listProjectGezelsText,
  listProjectsText,
  listScriptsText,
  listTasksText,
  messageGezelText,
  readArtifactText,
  readTaskNotesText,
  reanchorText,
  saveMemoryText,
  scriptRunText,
  searchMemoryText,
  searchResultText,
  stepCheckedArtifactPaths,
  stepCompletionMode,
  withLineNumbers,
  writeTaskNoteText,
} from '../tools/results.js';
import type { PortableStore } from './store.js';

type Value = Record<string, unknown>;

/**
 * The desktop's text for a phone tool's result, for the turn loop both hosts
 * share. Undefined for a tool whose desktop wording is not shared yet; the
 * caller then sends the value as JSON.
 */
export async function portableToolResultText(
  store: PortableStore,
  session: ChatSession,
  name: string,
  args: Record<string, unknown>,
  raw: unknown,
  extras: { contextWindow?: number } = {},
): Promise<{ text: string; isError: boolean } | undefined> {
  if (name === 'list_gilde' && Array.isArray(raw))
    return {
      text: listGildeText(raw as { id: string; name: string; description: string }[]),
      isError: false,
    };
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Value;
  const ok = (text: string) => ({ text, isError: false });
  const path = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'read_file': {
      const read = value as unknown as WorkspaceReadFileSuccess & { ranged?: boolean };
      if (!read.ranged) return ok(args.raw === true ? read.content : withLineNumbers(read.content));
      return ok(formatWorkspaceRead(read, args.raw === true));
    }
    case 'read_artifact':
    case 'read_document':
      return ok(readArtifactText(path, String(value.content ?? '')));
    case 'write_file':
      return ok(`Wrote ${path}`);
    case 'write_document':
      return ok(`Wrote document ${path}`);
    case 'write_artifact': {
      let hint = '';
      if (session.taskRef && session.stepId) {
        const task = await store.getTask(session.taskRef).catch(() => null);
        const step = task?.craftbook.steps.find((item) => item.id === session.stepId);
        hint = artifactCompletionHint(stepCompletionMode(step), {
          checkedByStep: stepCheckedArtifactPaths(step).includes(normalizeArtifactPath(path)),
        });
      }
      return ok(`Wrote ${path}${hint}`);
    }
    case 'append_to_file':
      return ok(appendedText(path, String(args.content ?? '').length, Number(value.totalChars)));
    case 'replace_in_file':
      return ok(editedText(path, value as { addedLines: number; removedLines: number }));
    case 'replace_lines': {
      const change = value as { addedLines: number; removedLines: number };
      return ok(
        editedText(path, change) +
          reanchorText({
            path,
            startLine: Number(args.startLine),
            addedLines: change.addedLines,
            removedLines: change.removedLines,
            content: String(value.content ?? ''),
          }),
      );
    }
    case 'list_dir':
    case 'list_artifacts':
    case 'list_documents': {
      const entries = (value.entries ?? []) as { path: string; isDirectory: boolean }[];
      if (name === 'list_dir' && (value.notFolder === 'missing' || value.notFolder === 'file'))
        return ok(listDirMissingText(path, value.notFolder, (value.nearby ?? []) as string[]));
      if (name === 'list_dir') return ok(listDirText(entries));
      if (name === 'list_documents') return ok(listDocumentsText(entries));
      return ok(listArtifactsText(entries, path, value.truncated === true));
    }
    case 'search_memory':
      return ok(
        searchMemoryText(
          (value.results ?? []) as { text: string; score: number; day: string; scope: string }[],
        ),
      );
    case 'save_memory':
      return ok(
        saveMemoryText(
          value.status === 'duplicate' ? 'duplicate' : 'saved',
          args.scope === 'project' ? 'project' : 'gezel',
        ),
      );
    case 'read_task_notes': {
      const stepId = typeof args.stepId === 'string' ? args.stepId.trim() || undefined : undefined;
      const notes = ((value.details as { notes?: TaskNote[] } | undefined)?.notes ??
        []) as TaskNote[];
      return ok(readTaskNotesText(String(value.ref), stepId, notes));
    }
    case 'write_task_note':
      return ok(
        writeTaskNoteText(
          String(value.ref),
          typeof value.stepId === 'string' ? value.stepId : undefined,
          value.note as { id: string; at: string },
        ),
      );
    case 'advance_task_step': {
      const ref = String(args.ref);
      const stepId = String(args.stepId ?? value.completedStepId ?? '');
      const gate = value.gate as (AdvanceGateOutcome & { decision?: string }) | undefined;
      if (gate?.decision === 'reject')
        return { text: advanceGateFailureText(ref, stepId, gate), isError: true };
      if (!value.task) return undefined;
      return ok(advanceTaskStepText(ref, stepId, value.task as Task));
    }
    case 'create_task': {
      const created = value as unknown as Task;
      if (!created.ref || !created.craftbook) return undefined;
      return ok(
        createTaskText(created, {
          dispatch: value.dispatched === true,
          callerGezelId: session.gezelId,
        }),
      );
    }
    case 'ask_user_question':
      if (value.emptyQuestion === true) return ok(ASK_USER_QUESTION_EMPTY_TEXT);
      if (typeof value.questionId !== 'string') return undefined;
      return ok(
        askUserQuestionText(
          value.questionId,
          value.deduped === true,
          value.colleague as { id: string; name: string } | undefined,
        ),
      );
    case 'message_gezel':
      if (typeof value.toGezelName !== 'string') return undefined;
      // The phone parks a handoff until this turn releases the engine.
      return ok(messageGezelText({ recipientName: value.toGezelName, deliveryState: 'parked' }));
    case 'run_installed_script':
      return scriptRunValueText(value);
    case 'list_gezels':
      return ok(
        listGezelsText((value.items ?? []) as { id: string; name: string; role?: string }[]),
      );
    case 'list_projects':
      return ok(listProjectsText((value.items ?? []) as { id: string; name: string }[]));
    case 'list_tasks':
      return ok(listTasksText((value.tasks ?? []) as Task[]));
    case 'get_task':
      return typeof value.ref === 'string' ? ok(getTaskText(value as { ref: string })) : undefined;
    case 'update_project':
      return ok(`Updated project ${String(args.id)}`);
    case 'add_gezel_to_project':
      return ok(
        addGezelToProjectText(
          String(value.gezelId),
          String(value.projectId),
          value.added !== false,
        ),
      );
    case 'list_scripts': {
      const items = (value.items ?? []) as {
        name: string;
        scope: string;
        meta: Parameters<typeof listScriptsText>[0][number]['meta'];
      }[];
      return ok(
        listScriptsText(
          items.filter((item) => item.scope !== 'standard'),
          items.filter((item) => item.scope === 'standard'),
        ),
      );
    }
    case 'search':
      return ok(
        searchResultText({
          results: (value.results ?? []) as SearchResultRow[],
          craftbooks: (value.craftbooks ?? []) as SearchCraftbookSuggestion[],
          projectId: session.projectId,
          truncated: value.truncated === true,
          sourcesIncomplete: value.sourcesIncomplete === true,
          ...(typeof args.cursor === 'number' ? { cursor: args.cursor } : {}),
          ...(extras.contextWindow !== undefined ? { contextWindow: extras.contextWindow } : {}),
        }).text,
      );
    case 'list_project_gezels': {
      const items = (value.items ?? []) as { id: string; name: string; role?: string }[];
      const projectId = typeof value.projectId === 'string' ? value.projectId : session.projectId;
      return ok(
        listProjectGezelsText(
          projectId,
          items.map((gezel) => ({ id: gezel.id, gezel })),
          [],
        ),
      );
    }
    case 'get_script_run':
      return typeof value.id === 'string'
        ? ok(getScriptRunText(value as { id: string; status: string }))
        : undefined;
    default:
      // A project type's named tool is a script run, rendered the way the
      // desktop's MCP server renders it.
      return scriptRunValueText(value);
  }
}

function scriptRunValueText(value: Value): { text: string; isError: boolean } | undefined {
  if (typeof value.runId !== 'string' || typeof value.status !== 'string') return undefined;
  const calls = (value.calls ?? []) as { kind: string; durationMs?: number; error?: string }[];
  return scriptRunText({
    runId: value.runId,
    status: value.status,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(value.output !== undefined ? { output: value.output } : {}),
    callsSummary: calls.map((call) => ({
      kind: call.kind,
      durationMs: call.durationMs ?? 0,
      ...(call.error ? { error: call.error } : {}),
    })),
  });
}
