// src/git.ts
//
// Все обращения к Git в этом расширении идут через функции этого файла.
// Если понадобится что-то поменять в том, как мы вызываем git — искать нужно
// только здесь, а не по всему extension.ts.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Результат выполнения git-команды: либо успех с текстом вывода,
// либо неудача с текстом ошибки. TypeScript заставит проверить,
// какой из двух случаев произошёл, прежде чем читать stdout или error.
type GitResult =
    | { ok: true; stdout: string }
    | { ok: false; error: string };

/**
 * Запускает произвольную git-команду в указанной папке репозитория.
 *
 * Пример вызова:
 *     const res = await runGit(['status', '--porcelain'], '/path/to/repo');
 *     if (res.ok) {
 *         console.log(res.stdout);
 *     }
 */
export async function runGit(args: string[], cwd: string): Promise<GitResult> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            // Отключаем запрос пароля/логина — иначе git может "зависнуть"
            // в ожидании ввода, которого никто не введёт.
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return { ok: true, stdout: stdout.trim() };
    } catch (err: any) {
        const message = err.stderr?.trim() || err.message || 'Неизвестная ошибка git';
        return { ok: false, error: message };
    }
}

/**
 * Проверяет состояние одного файла в репозитории.
 *
 * Возвращает:
 *     'modified'  — файл отслеживается git и был изменён
 *     'untracked' — файл новый, git о нём ещё не знает
 *     'clean'     — изменений нет, коммитить нечего
 *
 * Пример вызова:
 *     const status = await getFileStatus('/path/to/repo', 'src/app.ts');
 */
export async function getFileStatus(
    repoRoot: string,
    relPath: string
): Promise<'modified' | 'untracked' | 'clean'> {
    const res = await runGit(['status', '--porcelain', '--', relPath], repoRoot);

    if (!res.ok || !res.stdout) {
        return 'clean';
    }
    // В "porcelain"-формате первые символы строки — код статуса.
    // "??" значит "untracked" (новый файл), всё остальное — модификация.
    return res.stdout.startsWith('??') ? 'untracked' : 'modified';
}

/**
 * Возвращает построчные изменения (diff) файла относительно последнего коммита.
 *
 * Пример вызова:
 *     const diff = await getFileDiff('/path/to/repo', 'src/app.ts');
 */
export async function getFileDiff(repoRoot: string, relPath: string): Promise<string> {
    const res = await runGit(['diff', '--no-color', '--', relPath], repoRoot);
    return res.ok ? res.stdout : '';
}

/**
 * Возвращает хэш и сообщение последнего коммита в репозитории.
 *
 * Пример вызова:
 *     const { hash, message } = await getLastCommit('/path/to/repo');
 */
export async function getLastCommit(
    repoRoot: string
): Promise<{ hash: string; message: string }> {
    const res = await runGit(['log', '-1', '--format=%h%x09%s'], repoRoot);
    if (!res.ok || !res.stdout) {
        return { hash: '', message: '' };
    }
    const [hash, ...rest] = res.stdout.split('\t');
    return { hash, message: rest.join('\t') };
}

// Одна запись истории коммитов файла.
export interface FileHistoryEntry {
    hash: string;
    author: string;
    date: string;
    message: string;
}

/**
 * Возвращает последние 5 коммитов, которые затрагивали указанный файл.
 *
 * Пример вызова:
 *     const history = await getFileHistory('/path/to/repo', 'src/app.ts');
 */
export async function getFileHistory(
    repoRoot: string,
    relPath: string
): Promise<FileHistoryEntry[]> {
    const res = await runGit(
        ['log', '-5', '--date=short', '--format=%h%x09%an%x09%ad%x09%s', '--', relPath],
        repoRoot
    );
    if (!res.ok || !res.stdout) {
        return [];
    }
    return res.stdout.split('\n').map((line) => {
        const [hash, author, date, ...rest] = line.split('\t');
        return { hash, author, date, message: rest.join('\t') };
    });
}

/**
 * Возвращает полный diff конкретного коммита (аналог `git show <hash>`).
 *
 * Пример вызова:
 *     const details = await getCommitDetails('/path/to/repo', 'a1b2c3d');
 */
export async function getCommitDetails(repoRoot: string, hash: string): Promise<string> {
    const res = await runGit(['show', hash], repoRoot);
    return res.ok ? res.stdout : res.error;
}

/**
 * Возвращает краткую сводку по коммиту — список изменённых файлов
 * (аналог `git show --stat <hash>`).
 *
 * Пример вызова:
 *     const summary = await getCommitSummary('/path/to/repo', 'a1b2c3d');
 */
export async function getCommitSummary(repoRoot: string, hash: string): Promise<string> {
    const res = await runGit(['show', '--stat', hash, '--'], repoRoot);
    return res.ok ? res.stdout : res.error;
}


