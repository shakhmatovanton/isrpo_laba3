// src/git.ts (новый файл — вспомогательные функции)

import { execFile } from 'child_process';
import { promisify } from 'util';


const execFileAsync = promisify(execFile);

export async function runGit(
    args: string[],
    cwd: string
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            // Отключаем запрос пароля — иначе команда может зависнуть
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return { ok: true, stdout: stdout.trim() };
    } catch (err: any) {
        // У execFile ошибка — это объект с stderr
        const message = err.stderr?.trim() || err.message || 'Unknown git error';
        return { ok: false, error: message };
    }
}

/**
 * Проверяет, есть ли незакоммиченные изменения в указанном файле.
 * Возвращает:
 *   - 'modified'  — файл изменён (есть в git и был изменён)
 *   - 'untracked' — файл новый, ещё не в git
 *   - 'clean'     — изменений нет
 */
export async function getFileStatus(
    repoRoot: string,
    relPath: string
): Promise<'modified' | 'untracked' | 'clean'> {
    // --porcelain — машиночитаемый формат (стабильный, в отличие от обычного git status)
    const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain', '--', relPath],
        { cwd: repoRoot }
    );

    const line = stdout.trim();
    if (!line) {
        return 'clean';
    }
    // Первые два символа в porcelain — код статуса.
    // "??" — untracked, " M" — modified, "M " — staged, "MM" — staged + modified
    if (line.startsWith('??')) {
        return 'untracked';
    }
    return 'modified';
}