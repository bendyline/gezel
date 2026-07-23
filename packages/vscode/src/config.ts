import * as vscode from 'vscode';

export interface ResolvedConfig {
  daemonUrl: string | undefined;
  daemonToken: string | undefined;
  defaultGezel: string;
  spawnIfMissing: boolean;
}

export function readConfig(): ResolvedConfig {
  const cfg = vscode.workspace.getConfiguration('gezel');
  const url = (cfg.get<string>('daemonUrl') ?? '').trim();
  const token = (cfg.get<string>('daemonToken') ?? '').trim();
  return {
    daemonUrl: url || undefined,
    daemonToken: token || undefined,
    defaultGezel: cfg.get<string>('defaultGezel') ?? 'dev',
    spawnIfMissing: cfg.get<boolean>('spawnIfMissing') ?? true,
  };
}
