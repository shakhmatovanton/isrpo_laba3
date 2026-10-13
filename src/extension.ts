import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('quickCommit.commit', () => {
        vscode.window.showInformationMessage('Quick Commit: команда работает!');
    });
    context.subscriptions.push(disposable);
}

export function deactivate() {}
