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
     * Recovery path when the desktop consent dialog is unavailable.
     * Lists and approves grants with the host-only discovery credential;
     * the code is still required, so approval remains bound to the request
     * initiated by this extension.
     */
    vscode.commands.registerCommand('gezel.approvePendingApp', async () => {
      const conn = ctx.getConnection();
      if (!conn) {
        void vscode.window.showWarningMessage('Gezel: daemon not connected yet.');
        return;
      }
      const res = await conn.fetch(`${conn.baseUrl}/v1/apps`, {
        headers: { Authorization: `Bearer ${conn.firstPartyToken}` },
      });
      if (!res.ok) {
        void vscode.window.showErrorMessage(`Gezel: couldn't list apps — HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        grants: Array<{
          id: string;
          appId: string;
          appName: string;
          status: string;
          verificationRequired?: boolean;
        }>;
      };
      const pending = body.grants.filter((g) => g.status === 'pending');
      if (pending.length === 0) {
        void vscode.window.showInformationMessage(
          'No pending app connections. If VS Code logged a 300s consent timeout, hit "Gezel: Reconnect Daemon" first to file a fresh request.',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        pending.map((g) => ({
          label: `${g.appName}`,
          description: g.appId,
          detail: `Approve grant ${g.id.slice(0, 8)}…`,
          grant: g,
        })),
        { placeHolder: 'Select a pending connection to approve' },
      );
      if (!pick) return;
      let verificationCode: string | undefined;
      if (pick.grant.verificationRequired) {
        const entered = await vscode.window.showInputBox({
          title: `Approve ${pick.grant.appName}`,
          prompt: 'Enter the six-character connection code shown by the requesting application.',
          placeHolder: '___-___',
          ignoreFocusOut: true,
          validateInput: (value) =>
            normalizeVerificationCode(value)
              ? null
              : 'Enter a valid six-character connection code.',
        });
        if (entered === undefined) return;
        verificationCode = normalizeVerificationCode(entered) ?? undefined;
      }
      const approve = await conn.fetch(
        `${conn.baseUrl}/v1/apps/grant/${encodeURIComponent(pick.grant.id)}/approve`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${conn.firstPartyToken}`,
            ...(verificationCode ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(verificationCode ? { body: JSON.stringify({ verificationCode }) } : {}),
        },
      );
      if (!approve.ok) {
        const error = (await approve.json().catch(() => null)) as {
          error?: string;
          attemptsRemaining?: number;
        } | null;
        const remaining =
          typeof error?.attemptsRemaining === 'number'
            ? ` ${error.attemptsRemaining} attempt${error.attemptsRemaining === 1 ? '' : 's'} remaining.`
            : '';
        void vscode.window.showErrorMessage(
          error?.error === 'verification_code_invalid'
            ? `Gezel: that connection code did not match.${remaining}`
            : `Gezel: approval failed — ${error?.error ?? `HTTP ${approve.status}`}`,
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `Approved ${pick.grant.appName}. Reconnecting the Gezel extension…`,
      );
      await ctx.reconnect();
    }),
    /**
     * Recover from `already_connected`: the daemon has a `vscode` app
     * token from an earlier session, but VS Code's secrets store
     * doesn't have the matching string (different dev-host profile,
     * approved via `Approve Pending App Connection` after the SDK had
     * already given up, …). Every fresh launch then hits 409 on
     * `POST /v1/apps/register` and we never register a language model.
     *
     * Fix: DELETE the daemon-side token using the host-only discovery bearer, clear
     * the (likely empty) VS Code secret, then reconnect — which fires
     * a fresh `register`, lands a brand-new grant, and either
     * auto-approves (env var) or surfaces the normal consent flow.
     */
    vscode.commands.registerCommand('gezel.resetConnection', async () => {
      const conn = ctx.getConnection();
      if (!conn) {
        void vscode.window.showWarningMessage('Gezel: daemon not connected yet.');
        return;
      }
      const appId = 'vscode';
      const del = await conn.fetch(`${conn.baseUrl}/v1/apps/${encodeURIComponent(appId)}/token`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${conn.firstPartyToken}` },
      });
      if (!del.ok && del.status !== 404) {
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

function normalizeVerificationCode(value: string): string | null {
  const normalized = value.replace(/[-\s]/g, '').toUpperCase();
  return /^[2-9A-HJ-KM-NP-TV-Z]{6}$/.test(normalized)
    ? `${normalized.slice(0, 3)}-${normalized.slice(3)}`
    : null;
}
