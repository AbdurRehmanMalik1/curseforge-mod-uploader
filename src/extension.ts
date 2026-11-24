import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { UploadPanel } from './panel';

const TOKEN_KEY = 'curseforgeUpload.apiToken';
const TOKEN_PAGE = 'https://legacy.curseforge.com/account/api-tokens';

export async function getToken(ctx: vscode.ExtensionContext, ask: boolean): Promise<string | undefined> {
  const stored = await ctx.secrets.get(TOKEN_KEY);
  if (stored || !ask) {
    return stored;
  }
  return promptForToken(ctx);
}

async function promptForToken(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const open = 'Open token page';
  const token = await vscode.window.showInputBox({
    title: 'CurseForge API token',
    prompt: `Paste a CurseForge upload API token. Create one under your CurseForge account's API tokens page (${TOKEN_PAGE}). It is kept in VS Code's secret storage.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length < 8 ? 'That does not look like a token.' : undefined),
  });
  if (!token) {
    const choice = await vscode.window.showInformationMessage('An API token is needed to talk to CurseForge.', open);
    if (choice === open) {
      vscode.env.openExternal(vscode.Uri.parse(TOKEN_PAGE));
    }
    return undefined;
  }
  await ctx.secrets.store(TOKEN_KEY, token.trim());
  return token.trim();
}

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('curseforgeUpload.uploadFolder', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      let targets = uris && uris.length ? uris : uri instanceof vscode.Uri ? [uri] : undefined;
      if (!targets) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        const releases = ws && vscode.Uri.joinPath(ws, 'releases');
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: true,
          defaultUri: releases && existsSync(releases.fsPath) ? releases : ws,
          openLabel: 'Upload to CurseForge',
          title: 'Choose the release folder(s) with the mod jars',
        });
        if (!picked?.length) {
          return;
        }
        targets = picked;
      }
      await UploadPanel.show(ctx, targets.map((t) => t.fsPath));
    }),
    vscode.commands.registerCommand('curseforgeUpload.setToken', async () => {
      if (await promptForToken(ctx)) {
        vscode.window.showInformationMessage('CurseForge API token saved.');
      }
    }),
    vscode.commands.registerCommand('curseforgeUpload.clearToken', async () => {
      await ctx.secrets.delete(TOKEN_KEY);
      vscode.window.showInformationMessage('CurseForge API token removed.');
    }),
    vscode.commands.registerCommand('curseforgeUpload.clearHistory', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Forget which jars were already uploaded? The extension will stop warning about re-uploads of them.',
        { modal: true },
        'Forget',
      );
      if (ok) {
        await ctx.globalState.update('curseforgeUpload.history', undefined);
        vscode.window.showInformationMessage('Upload history cleared.');
      }
    }),
  );
}

export function deactivate(): void {}
