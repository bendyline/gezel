import type { GezelClient } from '@bendyline/gezel-client/node';
import * as vscode from 'vscode';
import type { ChatViewProvider } from './chat-view.js';
import type { Connection } from './daemon.js';
import type { Logger } from './log.js';

export interface CommandContext {
  view: ChatViewProvider;
  getClient: () => GezelClient | null;
  getConnection: () => Connection | null;
  getActiveGezel: () => { id: string; name: string } | null;
  setActiveGezel: (g: { id: string; name: string }) => void;
  getActiveFolder: () => vscode.WorkspaceFolder | null;
  setActiveFolder: (f: vscode.WorkspaceFolder) => Promise<void>;
  reconnect: () => Promise<void>;
  logger: Logger;
  getStatus: () => string;
  /**
   * Wipe the locally-cached per-app token from VS Code's secrets so the
   * SDK's consent flow runs fresh on the next reconnect. Exposed as a
   * context callback because the secrets API is bound to the
   * extension context, which lives in `extension.ts`.
   */
  clearAppTokenSecret: () => Promise<void>;
}

export function registerCommands(ctx: CommandContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gezel.openChat', () => {
      void vscode.commands.executeCommand(`${'gezel.chat'}.focus`);
      ctx.view.reveal();
    }),
    vscode.commands.registerCommand('gezel.switchGezel', async () => {
      const client = ctx.getClient();
      if (!client) {
        void vscode.window.showWarningMessage('Gezel: daemon not connected yet.');
        return;
      }
      const list = await client.listGezels();
      if (list.gezels.length === 0) {
        void vscode.window.showInformationMessage(
          'No gezels available. Create one in the gezel desktop app.',
        );
        return;
      }
      const active = ctx.getActiveGezel();
      const items = list.gezels.map((g) => ({
        label: g.name,
        description: g.role ?? '',
        detail: g.id === active?.id ? '(current)' : '',
        gezel: g,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a gezel to chat with',
      });
      if (pick) ctx.setActiveGezel({ id: pick.gezel.id, name: pick.gezel.name });
    }),
    vscode.commands.registerCommand('gezel.switchFolder', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length <= 1) {
        void vscode.window.showInformationMessage(
          'Only one workspace folder is open. Add another with File → Add Folder to Workspace.',
        );
        return;
      }
      const active = ctx.getActiveFolder();
      const items = folders.map((f) => ({
        label: f.name,
        description: f.uri.fsPath,
        detail: f.uri.toString() === active?.uri.toString() ? '(current)' : '',
        folder: f,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the workspace folder this chat is scoped to',
      });
      if (pick) await ctx.setActiveFolder(pick.folder);
    }),
    vscode.commands.registerCommand('gezel.refresh', async () => {
      ctx.logger.info('reconnect requested by user');
      await ctx.reconnect();
    }),
    vscode.commands.registerCommand('gezel.showLogs', () => {
      ctx.logger.show();
    }),
    vscode.commands.registerCommand('gezel.showStatus', async () => {
      const report = ctx.getStatus();
      ctx.logger.info(`status snapshot:\n${report}`);
      const pick = await vscode.window.showInformationMessage(
        report,
        { modal: true },
        'Show Logs',
        'Reconnect',
      );
      if (pick === 'Show Logs') ctx.logger.show();
      else if (pick === 'Reconnect') await ctx.reconnect();
    }),
    /**
     * Revoke VS Code's own scoped credential and run consent again. This is
     * intentionally the same self-service capability available to any
     * third-party app; the extension never receives first-party grant-admin
     * authority.
     */
    vscode.commands.registerCommand('gezel.resetConnection', async () => {
      const conn = ctx.getConnection();
      if (!conn) {
        await ctx.clearAppTokenSecret();
        void vscode.window.showInformationMessage(
          'Gezel: the local VS Code token was cleared. If Gezel still lists Visual Studio Code under Connected Apps, revoke it there, then reconnect.',
        );
        return;
      }
      const appId = 'vscode';
      const del = await conn.fetch(`${conn.baseUrl}/v1/apps/${encodeURIComponent(appId)}/token`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${conn.token}` },
      });
      if (!del.ok && del.status !== 401 && del.status !== 404) {
        void vscode.window.showErrorMessage(
          `Gezel: couldn't revoke daemon token — HTTP ${del.status}`,
        );
        return;
      }
      await ctx.clearAppTokenSecret();
      void vscode.window.showInformationMessage(
        'Gezel: connection reset. Reconnecting and re-requesting consent…',
      );
      await ctx.reconnect();
    }),
  ];
}
