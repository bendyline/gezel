import * as vscode from 'vscode';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  show(): void;
  dispose(): void;
}

export function createLogger(): Logger {
  const channel = vscode.window.createOutputChannel('Gezel');
  const stamp = () => new Date().toISOString();
  return {
    info(msg) {
      channel.appendLine(`${stamp()} INFO  ${msg}`);
    },
    warn(msg) {
      channel.appendLine(`${stamp()} WARN  ${msg}`);
    },
    error(msg) {
      channel.appendLine(`${stamp()} ERROR ${msg}`);
    },
    show() {
      channel.show(true);
    },
    dispose() {
      channel.dispose();
    },
  };
}
