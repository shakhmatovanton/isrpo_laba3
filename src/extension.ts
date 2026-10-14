import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFileStatus } from './git';


// Превращаем callback-функцию execFile в Promise,
// чтобы можно было использовать await
const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
    // Регистрируем команду в контексте расширения.
    // Обработчик — async-функция, чтобы работать с await.
    const commitCurrentFile = vscode.commands.registerCommand(
        'quickCommit.commit',
        async () => {
            // 1. Получить активный редактор
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Нет открытого файла.');
                return;
            }

            // 2. Узнать корень воркспейса (папка, открытая в VS Code)
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Открой папку проекта в VS Code.');
                return;
            }
            const repoRoot = workspaceFolder.uri.fsPath;
            const relPath = vscode.workspace.asRelativePath(editor.document.uri);

            // 3. Получить относительный путь файла от корня
            // Это нужно, чтобы git add работал в контексте репозитория
            const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
            
            // 4. Спросить сообщение коммита у пользователя
            const message = await vscode.window.showInputBox({
                prompt: 'Сообщение коммита',
                placeHolder: 'fix: something',
                ignoreFocusOut: true // диалог не закроется при клике в другое окно
            });

            // Если пользователь нажал Esc или ввёл пусто — отмена
            if (!message) {
                return;
            };

            const status = await getFileStatus(repoRoot, relPath);
            if (status === 'clean') {
                vscode.window.showInformationMessage(
                    `Нет изменений в файле ${relPath}`
                );
                return; // не идём дальше, коммита не будет
            }

            // 5. Выполнить git add и git commit
            try {
                await execFileAsync('git', ['add', relativePath], { cwd: repoRoot });
                await execFileAsync(
                    'git',
                    ['commit', '-m', message, relativePath],
                    { cwd: repoRoot }
                );
                vscode.window.showInformationMessage(`Закоммичено: ${relativePath}`);
            } catch (err: any) {
                // err.stderr содержит вывод git
                const errorText = err?.stderr?.toString() || err?.message || 'Неизвестная ошибка';
                vscode.window.showErrorMessage(`Ошибка Git: ${errorText.trim()}`);
            }
        }
    );

    // Кладём команду в subscriptions, чтобы VS Code очистил её при выключении
    context.subscriptions.push(commitCurrentFile);
}

export function deactivate() {}
