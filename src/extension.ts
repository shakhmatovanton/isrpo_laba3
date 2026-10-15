// src/extension.ts
//
// Расширение "Quick Commit" для VS Code.
// Добавляет две команды (вызываются через палитру команд — Ctrl+Shift+P):
//
//   1. "Quick Commit: commit current file"
//      Коммитит ТОЛЬКО тот файл, который сейчас открыт в редакторе —
//      остальные изменённые файлы в коммит не попадают.
//
//   2. "Quick Commit: Show History of Current File"
//      Показывает последние 5 коммитов, которые затрагивали открытый файл.
//
// Вся работа с git вынесена в файл git.ts. Здесь — только логика общения
// с пользователем: диалоги, сообщения, палитра команд.

import * as vscode from 'vscode';
import {
    runGit,
    getFileStatus,
    getFileDiff,
    getLastCommit,
    getFileHistory,
    getCommitDetails,
    getCommitSummary,
} from './git';

// Канал вывода, куда мы печатаем diff и детали коммитов.
// Пользователь видит его в панели Output (Ctrl+Shift+U), в выпадающем списке "Quick Commit".
let outputChannel: vscode.OutputChannel;

// Печатает текст в Output-канал, предварительно его очищая.
function showInOutput(title: string, text: string): void {
    outputChannel.clear();
    outputChannel.appendLine(title);
    outputChannel.appendLine('');
    outputChannel.appendLine(text);
    outputChannel.show(true); // true = не забирать фокус с редактора
}

/**
 * Находит открытый файл и корень git-репозитория, в котором он лежит.
 * Если что-то не так (нет файла, нет папки, файл вне папки) —
 * показывает сообщение об ошибке и возвращает null.
 */
function getActiveFileContext(): { repoRoot: string; relPath: string } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Quick Commit: нет открытого файла');
        return null;
    }

    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!repoRoot) {
        vscode.window.showErrorMessage('Quick Commit: папка не открыта');
        return null;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.startsWith(repoRoot)) {
        vscode.window.showErrorMessage('Quick Commit: файл находится вне открытой папки');
        return null;
    }

    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    return { repoRoot, relPath };
}

/**
 * Проверяет, что в repoRoot действительно есть git-репозиторий
 * и что у git настроены имя и email автора (без этого коммит не создать).
 */
async function checkGitIsReady(repoRoot: string): Promise<boolean> {
    const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], repoRoot);
    if (!isRepo.ok || isRepo.stdout !== 'true') {
        vscode.window.showErrorMessage('Quick Commit: не Git-репозиторий');
        return false;
    }

    const name = await runGit(['config', 'user.name'], repoRoot);
    if (!name.ok || !name.stdout) {
        vscode.window.showErrorMessage(
            'Quick Commit: не настроен user.name. Выполните: git config --global user.name "Имя"'
        );
        return false;
    }

    const email = await runGit(['config', 'user.email'], repoRoot);
    if (!email.ok || !email.stdout) {
        vscode.window.showErrorMessage(
            'Quick Commit: не настроен user.email. Выполните: git config --global user.email "email@example.com"'
        );
        return false;
    }

    return true;
}

/**
 * Показывает diff файла в Output-канале и спрашивает у пользователя подтверждение.
 * Возвращает true, если пользователь нажал "Да". Если изменений нет — возвращает false.
 */
async function confirmCommitWithDiff(repoRoot: string, relPath: string): Promise<boolean> {
    const diff = await getFileDiff(repoRoot, relPath);
    if (diff.trim().length === 0) {
        return false;
    }

    showInOutput(`=== Diff для ${relPath} ===`, diff);

    const answer = await vscode.window.showWarningMessage(
        `Закоммитить изменения в ${relPath}?`,
        { modal: true },
        'Да',
        'Нет'
    );
    return answer === 'Да';
}

/**
 * Спрашивает у пользователя сообщение коммита через всплывающее поле ввода.
 * Возвращает null, если пользователь отменил ввод или оставил поле пустым.
 */
async function askCommitMessage(): Promise<string | null> {
    const message = await vscode.window.showInputBox({
        prompt: 'Сообщение коммита',
        placeHolder: 'fix: something',
        // validateInput вызывается на каждое нажатие клавиши.
        // Если вернуть строку — она станет текстом ошибки под полем ввода.
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

    if (message === undefined || !message.trim()) {
        return null;
    }
    return message;
}

/**
 * Команда "Quick Commit: commit current file".
 *
 * Шаги: найти файл и репозиторий → проверить, что git настроен →
 * проверить, что в файле есть изменения → показать diff и спросить подтверждение →
 * спросить сообщение коммита → выполнить `git add` и `git commit` только для этого файла →
 * показать результат.
 */
async function commitCurrentFile(): Promise<void> {
    const context = getActiveFileContext();
    if (!context) {
        return;
    }
    const { repoRoot, relPath } = context;

    const gitReady = await checkGitIsReady(repoRoot);
    if (!gitReady) {
        return;
    }

    const status = await getFileStatus(repoRoot, relPath);
    if (status === 'clean') {
        vscode.window.showInformationMessage(`Нет изменений в файле ${relPath}`);
        return;
    }

    const confirmed = await confirmCommitWithDiff(repoRoot, relPath);
    if (!confirmed) {
        vscode.window.showInformationMessage('Quick Commit: коммит отменён');
        return;
    }

    const message = await askCommitMessage();
    if (!message) {
        vscode.window.showInformationMessage('Quick Commit: отменено');
        return;
    }

    // git add -- relPath   →  добавляем в индекс ТОЛЬКО этот файл.
    // "--" — разделитель: всё после него считается путями, а не опциями.
    // Это важно, если путь начинается с "-" или содержит пробелы.
    const addResult = await runGit(['add', '--', relPath], repoRoot);
    if (!addResult.ok) {
        vscode.window.showErrorMessage(`Quick Commit (add): ${addResult.error}`);
        return;
    }

    // git commit -m "..." -- relPath   →  коммитим ТОЛЬКО этот файл,
    // даже если в индексе случайно оказались другие застейдженные файлы —
    // они останутся в индексе и не потеряются.
    const commitResult = await runGit(['commit', '-m', message, '--', relPath], repoRoot);
    if (!commitResult.ok) {
        vscode.window.showErrorMessage(`Quick Commit (commit): ${commitResult.error}`);
        return;
    }

    const { hash, message: lastMessage } = await getLastCommit(repoRoot);
    const action = await vscode.window.showInformationMessage(
        `✅ Закоммичено: [${hash}] ${lastMessage}`,
        'Показать diff'
    );

    if (action === 'Показать diff') {
        const details = await getCommitDetails(repoRoot, hash);
        showInOutput(`=== Коммит ${hash} ===`, details);
    }
}

/**
 * Команда "Quick Commit: Show History of Current File".
 *
 * Показывает список последних 5 коммитов открытого файла.
 * При выборе коммита из списка — печатает его подробности в Output-канал.
 */
async function showFileHistory(): Promise<void> {
    const context = getActiveFileContext();
    if (!context) {
        return;
    }
    const { repoRoot, relPath } = context;

    const history = await getFileHistory(repoRoot, relPath);
    if (history.length === 0) {
        vscode.window.showInformationMessage(`Quick Commit: у файла ${relPath} ещё нет коммитов`);
        return;
    }

    // Превращаем историю коммитов в список для всплывающего меню (QuickPick).
    const items = history.map((entry) => ({
        label: `$(git-commit) ${entry.hash}`,
        description: `${entry.date} — ${entry.author}`,
        detail: entry.message,
        hash: entry.hash,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: `История файла: ${relPath}`,
        placeHolder: 'Выбери коммит для просмотра деталей',
        matchOnDetail: true,
    });

    if (picked) {
        const summary = await getCommitSummary(repoRoot, picked.hash);
        showInOutput(`=== Коммит ${picked.hash} ===`, summary);
    }
}

// Точка входа расширения. VS Code вызывает её один раз при активации.
export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Quick Commit');
    context.subscriptions.push(outputChannel);

    context.subscriptions.push(
        vscode.commands.registerCommand('quickCommit.commit', commitCurrentFile)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('quickCommit.showHistory', showFileHistory)
    );
}

// Вызывается при выключении расширения. Специально ничего не делает —
// всё, что нужно было освободить, мы уже положили в context.subscriptions.
export function deactivate(): void {}
// import * as vscode from 'vscode';
// import { execFile } from 'child_process';
// import { promisify } from 'util';
// import { getFileStatus, runGit, getOtherStagedFiles } from './git';



// // Превращаем callback-функцию execFile в Promise,
// // чтобы можно было использовать await
// const execFileAsync = promisify(execFile);

// // Создаём канал вывода для diff. Он будет виден пользователю 
// // в панели Output (Ctrl+Shift+U), в выпадающем списке — "Quick Commit".
// let outputChannel: vscode.OutputChannel;

// /**
//  * Возвращает diff текущего файла в виде строки.
//  * @param repoRoot — корень Git-репозитория
//  * @param relPath  — путь файла относительно корня
//  */
// async function getFileDiff(repoRoot: string, relPath: string): Promise<string> {
//     // git diff показывает изменения в рабочей директории (не staged).
//     // --no-color — чтобы в выводе не было ANSI-кодов (они не читаются в Output).
//     // -- — разделитель, после которого идёт путь. Нужен, если путь начинается с "-".
//     const { stdout } = await execFileAsync(
//         'git',
//         ['diff', '--no-color', '--', relPath],
//         { cwd: repoRoot }
//     );
//     return stdout;
// }
// /**
//  * Показывает diff в OutputChannel и спрашивает подтверждение.
//  * @returns true, если пользователь подтвердил; false, если отменил.
//  */
// async function previewAndConfirm(
//     repoRoot: string,
//     relPath: string
// ): Promise<boolean> {
//     const diff = await getFileDiff(repoRoot, relPath);

//     // Если diff пустой — изменений нет. Возвращаем false, дальше обработка на уровне вызывающего.
//     if (diff.trim().length === 0) {
//         return false;
//     }

//     // Очищаем канал от прошлого вывода и пишем новый diff.
//     outputChannel.clear();
//     outputChannel.appendLine(`=== Diff для ${relPath} ===`);
//     outputChannel.appendLine('');
//     outputChannel.appendLine(diff);
//     outputChannel.show(true); // true = не забирать фокус, чтобы модалка сразу появилась

//     // Модальный диалог: блокирует интерфейс, пока пользователь не выберет.
//     const answer = await vscode.window.showWarningMessage(
//         `Закоммитить изменения в ${relPath}?`,
//         { modal: true },
//         'Да',
//         'Нет'
//     );

//     return answer === 'Да';
// }

// async function getLastCommit(repoRoot: string): Promise<{ hash: string; message: string }> {
//     // %h — короткий хэш (обычно 7 символов)
//     // %s — сообщение коммита (subject, первая строка)
//     // %x09 — табуляция между ними
//     const { stdout } = await execFileAsync(
//         'git',
//         ['log', '-1', '--format=%h%x09%s'],
//         { cwd: repoRoot }
//     );

//     const [hash, ...messageParts] = stdout.trim().split('\t');
//     return {
//         hash,
//         message: messageParts.join('\t') // на случай табов в сообщении
//     };
// }

// export function activate(context: vscode.ExtensionContext) {
//     // Регистрируем команду в контексте расширения.
//     // Обработчик — async-функция, чтобы работать с await.
//     outputChannel = vscode.window.createOutputChannel('Quick Commit');
//     context.subscriptions.push(outputChannel);
//     const commitCurrentFile = vscode.commands.registerCommand(
//         'quickCommit.commit',
//         async () => {
//             // 1. Получить активный редактор
//             const editor = vscode.window.activeTextEditor;
//             if (!editor) {
//                 vscode.window.showErrorMessage('Quick Commit: нет открытого файла');
//                 return;
//             }

//             // 2. Узнать корень воркспейса (папка, открытая в VS Code)
//             const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
//             if (!repoRoot) {
//                 vscode.window.showErrorMessage('Quick Commit: папка не открыта');
//                 return;
//             }

//             const isRepo = await runGit(['rev-parse', '--is-inside-work-tree'], repoRoot);
//             if (!isRepo.ok || isRepo.stdout !== 'true') {
//                 vscode.window.showErrorMessage('Quick Commit: не Git-репозиторий');
//                 return;
//             }

//             const nameCheck = await runGit(['config', 'user.name'], repoRoot);
//             const emailCheck = await runGit(['config', 'user.email'], repoRoot);

//             if (!nameCheck.ok || !nameCheck.stdout) {
//                 vscode.window.showErrorMessage(
//                     'Quick Commit: не настроен user.name. Выполните: git config --global user.name "Имя"'
//                 );
//                 return;
//             }
//             if (!emailCheck.ok || !emailCheck.stdout) {
//                 vscode.window.showErrorMessage(
//                     'Quick Commit: не настроен user.email. Выполните: git config --global user.email "email@example.com"'
//                 );
//                 return;
//             }

//             const filePath = editor.document.uri.fsPath;
//             if (!filePath.startsWith(repoRoot)) {
//                 vscode.window.showErrorMessage(
//                     'Quick Commit: файл находится вне открытой папки'
//                 );
//                 return;
//             }

//             const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            
//             const status = await getFileStatus(repoRoot, relPath);
//             if (status === 'clean') {
//                 vscode.window.showInformationMessage(
//                     `Нет изменений в файле ${relPath}`
//                 );
//                 return; // не идём дальше, коммита не будет
//             }

//             // 4. Спросить сообщение коммита у пользователя
//             const message = await vscode.window.showInputBox({
//                 prompt: 'Сообщение коммита',
//                 placeHolder: 'fix: something',
//                 // validateInput вызывается на каждый ввод символа.
//                 // Если вернуть строку — она станет ошибкой под полем.
//                 validateInput: (value) => {
//                     if (!value.trim()) {
//                         return 'Сообщение не может быть пустым';
//                     }
//                     if (value.length > 200) {
//                         return 'Слишком длинное сообщение (макс. 200)';
//                     }
//                     return null;
//                 },
//             });

//             // Если пользователь нажал Esc или ввёл пусто — отмена
//             if (message === undefined || !message.trim()) {
//                 vscode.window.showInformationMessage('Quick Commit: отменено');
//                 return;
//             }

//             // ─── 8. Предпросмотр diff + подтверждение ──────────────────
//             const confirmed = await previewAndConfirm(repoRoot, relPath);
//             if (!confirmed) {
//                 vscode.window.showInformationMessage('Quick Commit: коммит отменён');
//                 return;
//             }

//             const otherStaged = await getOtherStagedFiles(repoRoot, relPath);

//             // git add -- relPath  →  стейджит ТОЛЬКО текущий файл.
//             // Флаг `--` — разделитель: всё после него считается путями, а не опциями.
//             // Это важно, если путь начинается с `-` или содержит пробелы.
//             const addRes = await runGit(['add', '--', relPath], repoRoot);
//             if (!addRes.ok) {
//                 vscode.window.showErrorMessage(`Quick Commit (add): ${addRes.error}`);
//                 return;
//             }

//             // git commit -m msg -- relPath
//             // Коммитит ТОЛЬКО этот путь, игнорируя staged-изменения других файлов.
//             // Они остаются в index и не теряются.
//             const commitRes = await runGit(
//                 ['commit', '-m', message, '--', relPath],
//                 repoRoot
//             );
//             if (!commitRes.ok) {
//                 vscode.window.showErrorMessage(`Quick Commit (commit): ${commitRes.error}`);
//                 return;
//             }

//             const hashRes = await runGit(
//                 ['log', '-1', '--format=%h %s'],
//                 repoRoot
//             );
//             if (hashRes.ok && hashRes.stdout) {
//                 vscode.window.showInformationMessage(
//                     `Закоммичено: ${hashRes.stdout}`
//                 );
//             } else {
//                 // Fallback: если log упал — просто сообщаем об успехе.
//                 vscode.window.showInformationMessage(
//                     `Закоммичено: ${relPath}`
//                 );
//             }

//             try {
//                 const { hash, message } = await getLastCommit(repoRoot);
//                 const action = await vscode.window.showInformationMessage(
//                     `✅ Закоммичено: [${hash}] ${message}`,
//                     'Показать diff'
//                 );

//                 if (action === 'Показать diff') {
//                     const { stdout: details } = await execFileAsync(
//                         'git',
//                         ['show', hash],
//                         { cwd: repoRoot }
//                     );
//                     outputChannel.clear();
//                     outputChannel.appendLine(`=== Коммит ${hash} ===`);
//                     outputChannel.appendLine('');
//                     outputChannel.appendLine(details);
//                     outputChannel.show(true);
//                 }
//             } catch (err: any) {
//                 vscode.window.showInformationMessage(`Закоммичено: ${relPath}`);
//             }
//         }
//     );

//     // Кладём команду в subscriptions, чтобы VS Code очистил её при выключении
//     context.subscriptions.push(commitCurrentFile);

//     const historyDisposable = vscode.commands.registerCommand(
//     'quickCommit.showHistory',
//     async () => {
//         // 1. Проверяем, есть ли открытый файл
//         const editor = vscode.window.activeTextEditor;
//         if (!editor) {
//             vscode.window.showErrorMessage('Quick Commit: нет открытого файла');
//             return;
//         }

//         // 2. Определяем корень репозитория
//         const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
//         if (!repoRoot) {
//             vscode.window.showErrorMessage('Quick Commit: не найден корень репозитория');
//             return;
//         }

//         // 3. Получаем относительный путь файла (git log работает именно с ним)
//         const relPath = vscode.workspace.asRelativePath(editor.document.uri);

//         try {
//             // 4. Запускаем git log с кастомным форматом
//             //    %h — короткий хэш
//             //    %an — имя автора
//             //    %ad — дата (в формате --date=short → YYYY-MM-DD)
//             //    %s — сообщение коммита (subject)
//             //    %x09 — символ табуляции (безопасный разделитель, не встретится в именах)
//             const { stdout } = await execFileAsync(
//                 'git',
//                 [
//                     'log',
//                     '-5',
//                     '--date=short',
//                     '--format=%h%x09%an%x09%ad%x09%s',
//                     '--',
//                     relPath
//                 ],
//                 { cwd: repoRoot }
//             );

//             // 5. Если вывод пустой — у файла ещё нет коммитов
//             if (!stdout.trim()) {
//                 vscode.window.showInformationMessage(
//                     `Quick Commit: у файла ${relPath} ещё нет коммитов`
//                 );
//                 return;
//             }

//             // 6. Парсим строки
//             const lines = stdout.trim().split('\n');
//             const items: vscode.QuickPickItem[] = lines.map(line => {
//                 const [hash, author, date, ...messageParts] = line.split('\t');
//                 const message = messageParts.join('\t'); // на случай, если в сообщении есть табы
//                 return {
//                     label: `$(git-commit) ${hash}`,
//                     description: `${date} — ${author}`,
//                     detail: message,
//                     // сохраняем хэш в поле — пригодится при выборе
//                     hash
//                 } as vscode.QuickPickItem & { hash: string };
//             });

//             // 7. Показываем список через QuickPick
//             const picked = await vscode.window.showQuickPick(items, {
//                 title: `История файла: ${relPath}`,
//                 placeHolder: 'Выбери коммит для просмотра деталей',
//                 matchOnDetail: true
//             });

//             // 8. Если пользователь выбрал — показываем детали
//             if (picked) {
//                 const hash = (picked as any).hash;
//                 const { stdout: details } = await execFileAsync(
//                     'git',
//                     ['show', '--stat', hash, '--'],
//                     { cwd: repoRoot }
//                 );
//                 const channel = vscode.window.createOutputChannel('Quick Commit: Details');
//                 channel.clear();
//                 channel.appendLine(details);
//                 channel.show();
//             }
//         } catch (err: any) {
//             vscode.window.showErrorMessage(
//                 `Quick Commit: ошибка git log — ${err.message}`
//             );
//         }
//     }
// );

// context.subscriptions.push(historyDisposable);
// }

// export function deactivate() {}


