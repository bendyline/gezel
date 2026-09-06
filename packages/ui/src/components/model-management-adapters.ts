import type {
  IncompleteModelDownload,
  LlamaCppInstallEvent,
  LlamaCppInstalledModel,
  LocalActiveInstall,
  MlxInstalledModel,
  UnrecognizedLocalModel,
} from '@bendyline/gezel-client';
import { api } from '../api.js';

/** Model-wide byte counts; optional shard detail belongs to engine presentation. */
export type ModelInstallEvent = LlamaCppInstallEvent & {
  file?: string;
  fileIndex?: number;
  fileCount?: number;
};
export interface ModelManagementAdapter<M extends { id: string }> {
  engine: 'llama-cpp' | 'mlx';
  list(): Promise<{ models: M[]; unrecognized?: UnrecognizedLocalModel[] }>;
  incomplete(): Promise<{ incomplete: IncompleteModelDownload[] }>;
  active(): Promise<{ installs: LocalActiveInstall[] }>;
  install(
    id: string,
    event: (event: ModelInstallEvent) => void,
    signal: AbortSignal,
    opts?: { skipSha: boolean },
  ): Promise<void>;
  cancel(id: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export const llamaModelAdapter: ModelManagementAdapter<LlamaCppInstalledModel> = {
  engine: 'llama-cpp',
  list: () => api.listLlamaCppModels(),
  incomplete: () => api.listIncompleteLlamaCppModels(),
  active: () => api.listLlamaCppActiveInstalls(),
  install: (...args) => api.installLlamaCppModel(...args),
  cancel: (id) => api.cancelLlamaCppModelInstall(id),
  remove: (id) => api.deleteLlamaCppModel(id),
};

export const mlxModelAdapter: ModelManagementAdapter<MlxInstalledModel> = {
  engine: 'mlx',
  list: () => api.listMlxModels(),
  incomplete: () => api.listIncompleteMlxModels(),
  active: () => api.listMlxActiveInstalls(),
  install: (id, event, signal, opts) =>
    api.installMlxModel(
      id,
      (ev) =>
        event(
          ev.type === 'progress'
            ? { ...ev, bytesWritten: ev.bytesWrittenAll, totalBytes: ev.totalBytesAll }
            : ev,
        ),
      signal,
      opts,
    ),
  cancel: (id) => api.cancelMlxModelInstall(id),
  remove: (id) => api.deleteMlxModel(id),
};
