// The "CurseForge Upload" channel in the Output panel: every request, the tags sent and the full
// answer from CurseForge when something goes wrong.
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function outputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('CurseForge Upload');
  }
  return channel;
}

export function log(line: string): void {
  outputChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
}
