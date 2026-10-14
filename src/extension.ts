import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFileStatus, runGit } from './git';


// Превращаем callback-функцию execFile в Promise,
// чтобы можно было использовать await
const execFileAsync = promisify(execFile);

// Создаём канал вывода для diff. Он будет виден пользователю 
// в панели Output (Ctrl+Shift+U), в выпадающем списке — "Quick Commit".
let outputChannel: vscode.OutputChannel;

/**
 * Возвращает diff текущего файла в виде строки.
 * @param repoRoot — корень Git-репозитория
 * @param relPath  — путь файла относительно корня
 */
async function getFileDiff(repoRoot: string, relPath: string): Promise<string> {
    // git diff показывает изменения в рабочей директории (не staged).
    // --no-color — чтобы в выводе не было ANSI-кодов (они не читаются в Output).
    // -- — разделитель, после которого идёт путь. Нужен, если путь начинается с "-".
    const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', '--', relPath],
        { cwd: repoRoot }
    );
    return stdout;
}
/**
 * Показывает diff в OutputChannel и спрашивает подтверждение.
 * @returns true, если пользователь подтвердил; false, если отменил.
 */
async function previewAndConfirm(
    repoRoot: string,
    relPath: string
): Promise<boolean> {
    const diff = await getFileDiff(repoRoot, relPath);

    // Если diff пустой — изменений нет. Возвращаем false, дальше обработка на уровне вызывающего.
    if (diff.trim().length === 0) {
        return false;
    }

    // Очищаем канал от прошлого вывода и пишем новый diff.
    outputChannel.clear();
    outputChannel.appendLine(`=== Diff для ${relPath} ===`);
    outputChannel.appendLine('');
    outputChannel.appendLine(diff);
    outputChannel.show(true); // true = не забирать фокус, чтобы модалка сразу появилась

    // Модальный диалог: блокирует интерфейс, пока пользователь не выберет.
    const answer = await vscode.window.showWarningMessage(
        `Закоммитить изменения в ${relPath}?`,
        { modal: true },
        'Да',
        'Нет'
    );

    return answer === 'Да';
}

export function activate(context: vscode.ExtensionContext) {
    // Регистрируем команду в контексте расширения.
    // Обработчик — async-функция, чтобы работать с await.
    outputChannel = vscode.window.createOutputChannel('Quick Commit');
    context.subscriptions.push(outputChannel);
    const commitCurrentFile = vscode.commands.registerCommand(
        'quickCommit.commit',
        async () => {
            // 1. Получить активный редактор
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('Quick Commit: нет открытого файла');
                return;
            }

            // 2. Узнать корень воркспейса (папка, открытая в VS Code)
            const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!repoRoot) {
                vscode.window.showErrorMessage('Quick Commit: папка не открыта');
                return;
            }

            const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], repoRoot);
            if (!isRepo.ok || isRepo.stdout !== 'true') {
                vscode.window.showErrorMessage('Quick Commit: не Git-репозиторий');
                return;
            }

            const nameCheck = await runGit(['config', 'user.name'], repoRoot);
            const emailCheck = await runGit(['config', 'user.email'], repoRoot);

            if (!nameCheck.ok || !nameCheck.stdout) {
                vscode.window.showErrorMessage(
                    'Quick Commit: не настроен user.name. Выполните: git config --global user.name "Имя"'
                );
                return;
            }
            if (!emailCheck.ok || !emailCheck.stdout) {
                vscode.window.showErrorMessage(
                    'Quick Commit: не настроен user.email. Выполните: git config --global user.email "email@example.com"'
                );
                return;
            }

            const filePath = editor.document.uri.fsPath;
            if (!filePath.startsWith(repoRoot)) {
                vscode.window.showErrorMessage(
                    'Quick Commit: файл находится вне открытой папки'
                );
                return;
            }

            const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            
            const status = await getFileStatus(repoRoot, relPath);
            if (status === 'clean') {
                vscode.window.showInformationMessage(
                    `Нет изменений в файле ${relPath}`
                );
                return; // не идём дальше, коммита не будет
            }

            // 4. Спросить сообщение коммита у пользователя
            const message = await vscode.window.showInputBox({
                prompt: 'Сообщение коммита',
                placeHolder: 'fix: something',
                // validateInput вызывается на каждый ввод символа.
                // Если вернуть строку — она станет ошибкой под полем.
                validateInput: (value) => {
                    if (!value.trim()) {
                        return 'Сообщение не может быть пустым';
                    }
                    if (value.length > 200) {
                        return 'Слишком длинное сообщение (макс. 200)';
                    }
                    return null;
                },
            });

            // Если пользователь нажал Esc или ввёл пусто — отмена
            if (message === undefined || !message.trim()) {
                vscode.window.showInformationMessage('Quick Commit: отменено');
                return;
            }

            // ─── 8. Предпросмотр diff + подтверждение ──────────────────
            const confirmed = await previewAndConfirm(repoRoot, relPath);
            if (!confirmed) {
                vscode.window.showInformationMessage('Quick Commit: коммит отменён');
                return;
            }

            const addRes = await runGit(
                ['add', '--', relPath],
                repoRoot
            );
            if (!addRes.ok) {
                vscode.window.showErrorMessage(
                    `Quick Commit (add): ${addRes.error}`
                );
                return;
            }

             const commitRes = await runGit(
                ['commit', '-m', message, '--', relPath],
                repoRoot
            );
            if (!commitRes.ok) {
                vscode.window.showErrorMessage(
                    `Quick Commit (commit): ${commitRes.error}`
                );
                return;
            }

            const hashRes = await runGit(
                ['log', '-1', '--format=%h %s'],
                repoRoot
            );
            if (hashRes.ok && hashRes.stdout) {
                vscode.window.showInformationMessage(
                    `Закоммичено: ${hashRes.stdout}`
                );
            } else {
                // Fallback: если log упал — просто сообщаем об успехе.
                vscode.window.showInformationMessage(
                    `Закоммичено: ${relPath}`
                );
            }
        }
    );

    // Кладём команду в subscriptions, чтобы VS Code очистил её при выключении
    context.subscriptions.push(commitCurrentFile);
}

export function deactivate() {}
